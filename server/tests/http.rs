use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    response::Response,
    Router,
};
use http_body_util::BodyExt;
use noto_server::{app, Config, Server};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tower::ServiceExt;
#[path="../../crates/noto-core/tests/support/webdav.rs"] mod webdav_fixture;

struct Fixture {
    root: tempfile::TempDir,
    app: Router,
}
impl Fixture {
    fn config(&self) -> Config {
        Config {
            vault: self.root.path().join("vault"),
            data: self.root.path().join("data"),
            frontend: self.root.path().join("web"),
            listen: "127.0.0.1:0".parse().unwrap(),
            password: Some("phase2-test-password".into()),
            allow_short_password: false,
            secure_cookie: false,
            public_origin: None,
            local_origin: None,
        }
    }
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        for dir in ["vault", "data", "web"] {
            fs::create_dir(root.path().join(dir)).unwrap();
        }
        fs::write(root.path().join("web/index.html"), "static app").unwrap();
        let mut fixture = Self {
            root,
            app: Router::new(),
        };
        fixture.app = app(Server::open(fixture.config()).unwrap());
        fixture
    }
    fn file(&self, relative: &str) -> PathBuf {
        self.root.path().join("vault").join(relative)
    }
    async fn login(&self) -> (String, String) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::post("/api/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::HOST, "localhost")
                    .header(header::ORIGIN, "http://localhost")
                    .body(Body::from(
                        json!({"password":"phase2-test-password"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(cookie.contains("HttpOnly; SameSite=Strict"));
        (
            cookie.split(';').next().unwrap().to_owned(),
            body(response).await["csrf"].as_str().unwrap().into(),
        )
    }
    async fn send(
        &self,
        session: &(String, String),
        method: Method,
        uri: &str,
        data: Value,
    ) -> Response {
        self.app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header(header::COOKIE, &session.0)
                    .header("x-noto-csrf", &session.1)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(data.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    async fn operation(&self, session: &(String, String), id: &str) -> Value {
        for _ in 0..200 {
            let result = body(
                self.send(
                    session,
                    Method::GET,
                    &format!("/api/operations/{id}"),
                    Value::Null,
                )
                .await,
            )
            .await;
            if !matches!(result["status"].as_str(), Some("running" | "queued")) {
                return result;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("operation did not finish");
    }
}
async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn storage_diagnostics_checks_configured_paths_and_requires_csrf() {
    const URI: &str = "/api/storage-diagnostics";
    let fixture = Fixture::new();
    let note = fixture.file("existing.md");
    fs::write(&note, "原文").unwrap();
    let guest = (String::new(), String::new());
    let response = fixture.send(&guest, Method::POST, URI, Value::Null).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let session = fixture.login().await;
    let bad_session = (session.0.clone(), String::new());
    let response = fixture.send(&bad_session, Method::POST, URI, Value::Null).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let response = fixture.send(&session, Method::POST, URI, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let report = body(response).await;
    for name in ["vault", "data"] {
        let directory = fixture.root.path().join(name).canonicalize().unwrap();
        assert_eq!(report[name]["path"].as_str(), directory.to_str());
        assert_eq!(report[name]["read"], "ok");
        assert_eq!(report[name]["write"], "ok");
        assert!(fs::read_dir(directory).unwrap().all(|entry| {
            !entry.unwrap().file_name().to_string_lossy().starts_with(".noto-storage-check-")
        }));
    }
    assert_eq!(fs::read_to_string(note).unwrap(), "原文");
}

#[tokio::test]
async fn note_activity_counts_creates_and_edits_and_requires_session() {
    use std::time::{SystemTime, UNIX_EPOCH};
    let fixture = Fixture::new();
    fs::write(fixture.file("existing.md"), "原文").unwrap();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
    let request = json!({"dayStarts":[now - 60000, now + 60000]});
    let guest = (String::new(), String::new());
    assert_eq!(fixture.send(&guest, Method::POST, "/api/note-activity", request.clone()).await.status(), StatusCode::UNAUTHORIZED);
    let session = fixture.login().await;
    let created = fixture.send(&session, Method::POST, "/api/note", json!({"path":"new.md","content":"新建"})).await;
    assert_eq!(created.status(), StatusCode::OK);
    let original = body(fixture.send(&session, Method::GET, "/api/note?path=existing.md", Value::Null).await).await;
    let edited = fixture.send(&session, Method::PUT, "/api/note?path=existing.md", json!({"expectedVersion":original["version"],"content":"改动"})).await;
    assert_eq!(edited.status(), StatusCode::OK);
    let activity = fixture.send(&session, Method::POST, "/api/note-activity", request).await;
    assert_eq!(activity.status(), StatusCode::OK);
    assert_eq!(body(activity).await, json!([{"created":1,"edited":1}]));
}
fn encoded(path: &str) -> String {
    path.as_bytes()
        .iter()
        .map(|b| format!("%{b:02X}"))
        .collect()
}

#[tokio::test]
async fn pdf_annotations_require_auth_and_reject_stale_writes() {
    const FILE: &str = "/api/pdf?path=paper.pdf";
    const WRITE: &str = "/api/pdf/annotations?path=paper.pdf";
    let f = Fixture::new();
    let bytes = b"%PDF-1.7\nexample";
    fs::write(f.file("paper.pdf"), bytes).unwrap();
    fs::write(f.file("not-a-pdf.pdf"), b"invalid PDF").unwrap();
    let anonymous = (String::new(), String::new());
    assert_eq!(f.send(&anonymous, Method::GET, FILE, Value::Null).await.status(), StatusCode::UNAUTHORIZED);
    let session = f.login().await;
    assert_eq!(f.send(&session, Method::GET, "/api/pdf?path=not-a-pdf.pdf", Value::Null).await.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let doc = body(f.send(&session, Method::GET, FILE, Value::Null).await).await;
    let version = doc["version"].as_str().unwrap();
    assert!(version.starts_with("sha256-"));
    let read = format!("/api/pdf/annotations?version={version}");
    assert_eq!(body(f.send(&session, Method::GET, &read, Value::Null).await).await, json!({"revision":null,"annotations":[]}));
    let mut update = json!({
        "documentVersion": version, "expectedRevision": null,
        "annotations": [{
            "id": "00112233445566778899aabbccddeeff", "page": 2, "kind": "note",
            "rects": [{"x":0.1,"y":0.2,"width":0.3,"height":0.04}], "text": "PDF", "comment": "NAS"
        }]
    });
    assert_eq!(f.send(&(session.0.clone(), String::new()), Method::PUT, WRITE, update.clone()).await.status(), StatusCode::FORBIDDEN);
    let saved = body(f.send(&session, Method::PUT, WRITE, update.clone()).await).await;
    assert!(saved["revision"].is_string());
    assert_eq!(body(f.send(&session, Method::PUT, WRITE, update.clone()).await).await, saved);

    update["annotations"][0]["comment"] = json!("并发修改");
    assert_eq!(f.send(&session, Method::PUT, WRITE, update.clone()).await.status(), StatusCode::CONFLICT);
    update["expectedRevision"] = saved["revision"].clone();
    update["annotations"][0]["rects"][0]["height"] = json!(5);
    assert_eq!(f.send(&session, Method::PUT, WRITE, update.clone()).await.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(fs::read(f.file("paper.pdf")).unwrap(), bytes);
    assert!(f.file(&format!("PDF 标注/{version}.json")).is_file());
    fs::rename(f.file("paper.pdf"), f.file("renamed.PDF")).unwrap();
    let renamed = body(f.send(&session, Method::GET, "/api/pdf?path=renamed.PDF", Value::Null).await).await;
    assert_eq!(renamed["version"], version);
    assert_eq!(body(f.send(&session, Method::GET, &read, Value::Null).await).await, saved);
}

#[tokio::test]
async fn webdav_routes_reuse_auth_csrf_and_preserve_protected_files_and_binary_attachments(){
    let f=Fixture::new();let dav=webdav_fixture::DavFixture::new();let config=json!({"url":dav.url,"username":"user","password":"pass","remotePath":"Noto"});
    let unauth=f.app.clone().oneshot(Request::post("/api/webdav/sync").header(header::CONTENT_TYPE,"application/json").body(Body::from(json!({"config":config}).to_string())).unwrap()).await.unwrap();assert_eq!(unauth.status(),StatusCode::UNAUTHORIZED);
    let session=f.login().await;let missing_csrf=f.app.clone().oneshot(Request::post("/api/webdav/test").header(header::COOKIE,&session.0).header(header::CONTENT_TYPE,"application/json").body(Body::from(config.to_string())).unwrap()).await.unwrap();assert_eq!(missing_csrf.status(),StatusCode::FORBIDDEN);
    assert_eq!(f.send(&session,Method::POST,"/api/webdav/test",config.clone()).await.status(),StatusCode::NO_CONTENT);
    fs::write(f.file("a.md"),"disk").unwrap();fs::create_dir(f.file("attachments")).unwrap();fs::write(f.file("attachments/a.png"),b"\x89PNG\x00\xff").unwrap();dav.model.lock().unwrap().put("/dav/Noto/a.md","remote");
    let result=body(f.send(&session,Method::POST,"/api/webdav/sync",json!({"config":config,"protectedPaths":["a.md"],"resolutions":[]})).await).await;
    assert_eq!(result["uploaded"],1);assert_eq!(result["skipped"][0],"a.md");assert_eq!(fs::read_to_string(f.file("a.md")).unwrap(),"disk");assert_eq!(dav.model.lock().unwrap().files["/dav/Noto/attachments/a.png"].0,b"\x89PNG\x00\xff");
    let bad=body(f.send(&session,Method::POST,"/api/webdav/test",json!({"url":dav.url,"username":"user","password":"private-wrong-secret","remotePath":"Noto"})).await).await;assert!(!bad.to_string().contains("private-wrong-secret"));assert!(bad["message"].as_str().unwrap().contains("认证"));
}

#[tokio::test]
async fn recovery_snapshots_are_private_version_checked_and_do_not_replace_notes() {
    let f = Fixture::new(); fs::write(f.file("a.md"), "旧磁盘内容").unwrap();
    let unauth = f.app.clone().oneshot(Request::get("/api/history?path=a.md").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
    let session = f.login().await;
    let note = body(f.send(&session, Method::GET, "/api/note?path=a.md", Value::Null).await).await;
    let saved = body(f.send(&session, Method::PUT, "/api/note?path=a.md", json!({"content":"新磁盘内容","expectedVersion":note["version"]})).await).await;
    let list = body(f.send(&session, Method::GET, "/api/history?path=a.md", Value::Null).await).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    let id = list[0]["id"].as_str().unwrap();
    let snapshot = body(f.send(&session, Method::GET, &format!("/api/history/content?path=a.md&id={id}"), Value::Null).await).await;
    assert_eq!(snapshot["content"], "旧磁盘内容"); assert_eq!(snapshot["reason"], "save");
    let conflict = f.send(&session, Method::POST, "/api/history/checkpoint", json!({"path":"a.md","content":"未保存编辑","expectedVersion":note["version"]})).await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    let checkpoint = f.send(&session, Method::POST, "/api/history/checkpoint", json!({"path":"a.md","content":"未保存编辑","expectedVersion":saved["version"]})).await;
    assert_eq!(checkpoint.status(), StatusCode::NO_CONTENT); assert_eq!(fs::read_to_string(f.file("a.md")).unwrap(), "新磁盘内容");
    let list = body(f.send(&session, Method::GET, "/api/history?path=a.md", Value::Null).await).await;
    assert_eq!(list.as_array().unwrap().len(), 3); assert_eq!(list[0]["reason"], "restore");
    for path in ["../a.md", ".noto-history/a.md"] {
        assert!(!f.send(&session, Method::GET, &format!("/api/history?path={}",encoded(path)), Value::Null).await.status().is_success());
    }
    assert!(!f.send(&session, Method::GET, &format!("/api/history/content?path=b.md&id={id}"), Value::Null).await.status().is_success());
    let tree = body(f.send(&session, Method::GET, "/api/entries", Value::Null).await).await;
    assert!(tree.as_array().unwrap().iter().all(|e|e["name"]!=".noto-history"));
}

#[cfg(unix)]
#[tokio::test]
async fn unsupported_unix_names_are_diagnosed_without_opening_an_alias() {
    let f = Fixture::new();
    fs::create_dir(f.file("项目")).unwrap();
    fs::write(f.file("项目/笔记.md"), "正常内容").unwrap();
    fs::write(f.file(r"项目\笔记.md"), "不得误改").unwrap();
    fs::write(f.file("项目:纪要.md"), "冒号原文").unwrap();
    let session = f.login().await;
    let entries = body(f.send(&session, Method::GET, "/api/entries", Value::Null).await).await;
    for name in [r"项目\笔记.md", "项目:纪要.md"] {
        let item = entries.as_array().unwrap().iter().find(|entry| entry["name"] == name).unwrap();
        assert_eq!(item["path"], name);
        assert!(item["issue"].as_str().is_some());
        let response = f.send(&session, Method::GET, &format!("/api/note?path={}", encoded(name)), Value::Null).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(fs::read_to_string(f.file(name)).unwrap(), if name.contains(':') { "冒号原文" } else { "不得误改" });
    }
    let response = f.send(&session, Method::GET, &format!("/api/note?path={}", encoded("项目/笔记.md")), Value::Null).await;
    assert_eq!(body(response).await["content"], "正常内容");
}

#[tokio::test]
async fn auth_csrf_origin_and_session_expiry() {
    let f = Fixture::new();
    for path in [
        "/api/entries",
        "/api/note?path=a.md",
        "/api/image?note=a.md&link=a.png",
        "/api/attachment?note=a.md&link=a.png",
        "/api/trash",
    ] {
        let response = f
            .app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
    let response = f
        .app
        .clone()
        .oneshot(
            Request::post("/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::HOST, "localhost")
                .header(header::ORIGIN, "https://evil.example")
                .body(Body::from(
                    json!({"password":"phase2-test-password"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let session = f.login().await;
    assert_eq!(
        f.send(
            &(session.0.clone(), "wrong".into()),
            Method::POST,
            "/api/note",
            json!({"path":"a.md"})
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let response = f
        .app
        .clone()
        .oneshot(
            Request::get("/api/entries")
                .header(header::COOKIE, &session.0)
                .header("sec-fetch-site", "cross-site")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        f.send(&session, Method::DELETE, "/api/session", Value::Null)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        f.send(&session, Method::GET, "/api/entries", Value::Null)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn remote_and_local_origins_share_notes_with_appropriate_cookies() {
    const REMOTE: &str = "https://noto.example";
    const LOCAL: &str = "http://192.168.40.20:41047";

    async fn login(app: &Router, origin: &str, site: &str) -> Response {
        app.clone().oneshot(
            Request::post("/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::HOST, "backend:3457")
                .header(header::ORIGIN, origin)
                .header("sec-fetch-site", site)
                .body(Body::from(json!({"password": "phase2-test-password"}).to_string()))
                .unwrap(),
        ).await.unwrap()
    }

    let mut f = Fixture::new();
    f.app = Router::new();
    let mut config = f.config();
    config.public_origin = Some(REMOTE.into());
    config.secure_cookie = true;
    let single_origin = app(Server::open(config).unwrap());
    assert_eq!(login(&single_origin, LOCAL, "same-origin").await.status(), StatusCode::FORBIDDEN);

    let mut config = f.config();
    config.public_origin = Some(REMOTE.into());
    config.local_origin = Some(LOCAL.into());
    config.secure_cookie = true;
    f.app = app(Server::open(config).unwrap());

    let remote = login(&f.app, REMOTE, "same-origin").await;
    assert_eq!(remote.status(), StatusCode::OK);
    let remote_cookie = remote.headers()[header::SET_COOKIE].to_str().unwrap().to_owned();
    assert!(remote_cookie.contains("; Secure"));
    let remote_cookie = remote_cookie.split(';').next().unwrap().to_owned();

    let local = login(&f.app, LOCAL, "same-origin").await;
    assert_eq!(local.status(), StatusCode::OK);
    let local_cookie = local.headers()[header::SET_COOKIE].to_str().unwrap().to_owned();
    assert!(!local_cookie.contains("; Secure"));
    let local_cookie = local_cookie.split(';').next().unwrap().to_owned();
    let local_csrf = body(local).await["csrf"].as_str().unwrap().to_owned();

    let created = f.app.clone().oneshot(
        Request::post("/api/note")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ORIGIN, LOCAL)
            .header("sec-fetch-site", "same-origin")
            .header(header::COOKIE, local_cookie)
            .header("x-noto-csrf", local_csrf)
            .body(Body::from(json!({"path":"shared.md","content":"共享笔记"}).to_string()))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let read = f.app.clone().oneshot(
        Request::get("/api/note?path=shared.md")
            .header(header::ORIGIN, REMOTE)
            .header("sec-fetch-site", "same-origin")
            .header(header::COOKIE, remote_cookie)
            .body(Body::empty())
            .unwrap(),
    ).await.unwrap();
    assert_eq!(read.status(), StatusCode::OK);
    assert_eq!(body(read).await["content"], "共享笔记");

    for (origin, site) in [
        ("http://192.168.40.20:41048", "same-origin"),
        ("https://evil.example", "same-origin"),
        (LOCAL, "cross-site"),
        (REMOTE, "cross-site"),
    ] {
        assert_eq!(login(&f.app, origin, site).await.status(), StatusCode::FORBIDDEN);
    }
    let invalid_origin = axum::http::HeaderValue::from_bytes(&[0xff]).unwrap();
    let invalid = single_origin.oneshot(
        Request::post("/api/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ORIGIN, invalid_origin)
            .body(Body::from(json!({"password":"phase2-test-password"}).to_string()))
            .unwrap(),
    ).await.unwrap();
    assert_eq!(invalid.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn automatic_local_origin_follows_private_ip_and_keeps_https_cookie() {
    const REMOTE: &str = "https://noto.example";
    let fixture = Fixture::new();
    let mut config = fixture.config();
    config.local_origin = Some("auto".into());
    config.public_origin = Some(REMOTE.into());
    config.secure_cookie = true;
    config.allow_short_password = true;
    config.password = Some("0012".into());
    let router = app(Server::open(config).unwrap());

    let login = |host: &str, origin: &str, site: &str| {
        router.clone().oneshot(
            Request::post("/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::HOST, host)
                .header(header::ORIGIN, origin)
                .header("x-forwarded-host", "192.168.40.20:41207")
                .header("x-forwarded-proto", "http")
                .header("sec-fetch-site", site)
                .body(Body::from(json!({"password": "0012"}).to_string()))
                .unwrap(),
        )
    };

    for host in ["192.168.40.20:41207", "10.0.0.50:41207", "[fd12::50]:41207"] {
        let local = login(host, &format!("http://{host}"), "same-origin")
            .await
            .unwrap();
        assert_eq!(local.status(), StatusCode::OK, "{host}");
        let cookie = local.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.contains("HttpOnly; SameSite=Strict"));
        assert!(!cookie.contains("; Secure"));
    }

    let remote = login("backend:3457", REMOTE, "same-origin").await.unwrap();
    assert_eq!(remote.status(), StatusCode::OK);
    assert!(remote.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .contains("; Secure"));

    for (host, origin, site) in [
        ("backend:3457", "http://192.168.40.20:41207", "same-origin"),
        ("192.168.40.20:41207", "http://192.168.40.20:41208", "same-origin"),
        ("192.168.40.20:41207", "http://192.168.40.20:41207", "cross-site"),
        ("203.0.113.10:41207", "http://203.0.113.10:41207", "same-origin"),
        ("unlisted.example", "http://unlisted.example", "same-origin"),
        ("192.168.40.20:41207", "https://192.168.40.20:41207", "same-origin"),
    ] {
        let denied = login(host, origin, site).await.unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN, "{origin}");
        assert_eq!(body(denied).await["code"], "origin");
    }
}

#[tokio::test]
async fn short_password_requires_opt_in_and_preserves_existing_state() {
    let mut f = Fixture::new();
    fs::write(f.file("保留.md"), "原有笔记").unwrap();
    let identity_path = f.root.path().join("data/identity.json");
    let original = fs::read(&identity_path).unwrap();
    let original_identity: Value = serde_json::from_slice(&original).unwrap();
    f.app = Router::new();

    for (password, allow_short) in [("0012", false), ("001", true)] {
        let mut config = f.config();
        config.password = Some(password.into());
        config.allow_short_password = allow_short;
        assert!(Server::open(config).is_err());
        assert_eq!(fs::read(&identity_path).unwrap(), original);
    }

    let mut config = f.config();
    config.password = Some("0012".into());
    config.allow_short_password = true;
    f.app = app(Server::open(config).unwrap());
    let updated: Value = serde_json::from_slice(&fs::read(&identity_path).unwrap()).unwrap();
    assert_eq!(updated["server_id"], original_identity["server_id"]);
    assert_eq!(updated["vault_id"], original_identity["vault_id"]);
    assert_ne!(updated["password_hash"], original_identity["password_hash"]);

    for (password, expected) in [
        ("phase2-test-password", StatusCode::UNAUTHORIZED),
        ("0012", StatusCode::OK),
    ] {
        let response = f.app.clone().oneshot(
            Request::post("/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::HOST, "localhost")
                .header(header::ORIGIN, "http://localhost")
                .body(Body::from(json!({"password": password}).to_string()))
                .unwrap(),
        ).await.unwrap();
        assert_eq!(response.status(), expected);
    }

    f.app = Router::new();
    let mut config = f.config();
    config.password = Some("0012".into());
    assert!(Server::open(config).is_err());
    let mut config = f.config();
    config.password = Some("0012".into());
    config.allow_short_password = true;
    assert!(Server::open(config).is_ok());
    assert_eq!(fs::read_to_string(f.file("保留.md")).unwrap(), "原有笔记");

    let mut config = f.config();
    config.password = Some("001234".into());
    config.allow_short_password = true;
    assert!(Server::open(config).is_ok());
}

#[tokio::test]
async fn unicode_crud_versions_and_invalid_paths() {
    let f = Fixture::new();
    let s = f.login().await;
    assert_eq!(
        f.send(
            &s,
            Method::POST,
            "/api/directory",
            json!({"path":"中文目录"})
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let path = "中文目录/笔 记.md";
    let note = body(
        f.send(
            &s,
            Method::POST,
            "/api/note",
            json!({"path":path,"content":"# 笔记\n"}),
        )
        .await,
    )
    .await;
    assert_eq!(note["path"], path);
    assert_eq!(
        f.send(
            &s,
            Method::POST,
            "/api/note",
            json!({"path":path,"content":"覆盖"})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let uri = format!("/api/note?path={}", encoded(path));
    let saved = body(
        f.send(
            &s,
            Method::PUT,
            &uri,
            json!({"content":"新内容","expectedVersion":note["version"]}),
        )
        .await,
    )
    .await;
    assert_ne!(saved["version"], note["version"]);
    assert_eq!(
        f.send(
            &s,
            Method::PUT,
            &uri,
            json!({"content":"旧版本覆盖","expectedVersion":note["version"]})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(fs::read_to_string(f.file(path)).unwrap(), "新内容");
    for invalid in [
        "../outside.md",
        "/absolute.md",
        "C:/secret.md",
        "a\\b.md",
        ".noto-trash/a.md",
        "目录/.backup/x.md",
        "a/../b.md",
    ] {
        assert_eq!(
            f.send(
                &s,
                Method::GET,
                &format!("/api/note?path={}", encoded(invalid)),
                Value::Null
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST,
            "{invalid}"
        );
    }
    let unknown = f
        .send(&s, Method::GET, "/api/no-such-route", Value::Null)
        .await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(unknown).await["code"], "not_found");
    fs::write(f.file("BOM.md"), b"\xef\xbb\xbfline1\r\nline2\r\n").unwrap();
    let note = body(
        f.send(&s, Method::GET, "/api/note?path=BOM.md", Value::Null)
            .await,
    )
    .await;
    assert_eq!(
        f.send(
            &s,
            Method::PUT,
            "/api/note?path=BOM.md",
            json!({"content":"after\n","expectedVersion":note["version"]})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        fs::read(f.file("BOM.md")).unwrap(),
        b"\xef\xbb\xbfafter\r\n"
    );
}

#[tokio::test]
async fn attachments_preserve_bytes_download_safely_and_reject_escape() {
    let f = Fixture::new();
    let s = f.login().await;
    fs::write(f.file("note.md"), "note").unwrap();
    let content = b"\x89PNG\r\n\0\xffbinary";
    let mut links = vec![];
    for _ in 0..2 {
        let mut data = "--noto-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"图 片.png\"\r\nContent-Type: image/png\r\n\r\n".as_bytes().to_vec();
        data.extend(content);
        data.extend(b"\r\n--noto-test--\r\n");
        let response = f
            .app
            .clone()
            .oneshot(
                Request::post("/api/attachment?path=note.md")
                    .header(header::COOKIE, &s.0)
                    .header("x-noto-csrf", &s.1)
                    .header(
                        header::CONTENT_TYPE,
                        "multipart/form-data; boundary=noto-test",
                    )
                    .body(Body::from(data))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        links.push(body(response).await.as_str().unwrap().to_owned());
    }
    assert_ne!(links[0], links[1]);
    let url = format!("/api/attachment?note=note.md&link={}", encoded(&links[0]));
    let response = f.send(&s, Method::GET, &url, Value::Null).await;
    assert!(response.headers()[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .starts_with("attachment;"));
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        content
    );
    let image = body(
        f.send(
            &s,
            Method::GET,
            &format!("/api/image?note=note.md&link={}", encoded(&links[0])),
            Value::Null,
        )
        .await,
    )
    .await;
    assert!(image
        .as_str()
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert_eq!(
        f.send(
            &s,
            Method::GET,
            "/api/attachment?note=note.md&link=../../data/identity.json",
            Value::Null
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    fs::create_dir(f.file(".private")).unwrap();
    fs::write(f.file(".private/secret.md"), "secret").unwrap();
    assert_eq!(
        f.send(
            &s,
            Method::GET,
            "/api/attachment?note=note.md&link=.private/secret.md",
            Value::Null
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn trash_restores_without_overwriting_and_survives_restart() {
    let mut f = Fixture::new();
    let s = f.login().await;
    fs::create_dir(f.file("folder")).unwrap();
    fs::write(f.file("folder/note.md"), "original").unwrap();
    assert_eq!(
        f.send(&s, Method::DELETE, "/api/item?path=folder", Value::Null)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert!(!f.file("folder").exists());
    f.app = app(Server::open(f.config()).unwrap());
    assert_eq!(
        f.send(&s, Method::GET, "/api/trash", Value::Null)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let s = f.login().await;
    let items = body(f.send(&s, Method::GET, "/api/trash", Value::Null).await).await;
    let id = items[0]["id"].as_str().unwrap();
    fs::create_dir(f.file("folder")).unwrap();
    assert_eq!(
        f.send(
            &s,
            Method::POST,
            &format!("/api/trash/{id}/restore"),
            Value::Null
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    fs::remove_dir(f.file("folder")).unwrap();
    assert_eq!(
        f.send(
            &s,
            Method::POST,
            &format!("/api/trash/{id}/restore"),
            Value::Null
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        fs::read_to_string(f.file("folder/note.md")).unwrap(),
        "original"
    );
    assert_eq!(
        body(f.send(&s, Method::GET, "/api/trash", Value::Null).await).await,
        json!([])
    );
}

#[tokio::test]
async fn relocation_is_durable_idempotent_and_version_guarded() {
    let f = Fixture::new();
    let s = f.login().await;
    fs::write(f.file("a.md"), "# A").unwrap();
    fs::write(f.file("reference.md"), "[[a]]").unwrap();
    let a = body(
        f.send(&s, Method::GET, "/api/note?path=a.md", Value::Null)
            .await,
    )
    .await;
    let r = body(
        f.send(&s, Method::GET, "/api/note?path=reference.md", Value::Null)
            .await,
    )
    .await;
    let id = "12345678123456781234567812345678";
    let plan = json!({"moves":[{"from":"a.md","to":"新目录/b.md"}],"checks":[{"path":"a.md","version":a["version"]},{"path":"reference.md","version":r["version"]}],"edits":[{"path":"a.md","target":"新目录/b.md","content":"# A","expectedVersion":a["version"]},{"path":"reference.md","target":"reference.md","content":"[[新目录/b]]","expectedVersion":r["version"]}]});
    assert_eq!(
        f.send(
            &s,
            Method::POST,
            &format!("/api/operations/{id}"),
            plan.clone()
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    let op = f.operation(&s, id).await;
    assert_eq!(op["status"], "completed", "{op}");
    assert_eq!(op["completedMoves"].as_array().unwrap().len(), 1);
    assert!(!f.file("a.md").exists());
    assert_eq!(
        fs::read_to_string(f.file("reference.md")).unwrap(),
        "[[新目录/b]]"
    );
    assert_eq!(
        fs::read_to_string(
            f.root
                .path()
                .join("data")
                .join(op["backup"].as_str().unwrap())
                .join("reference.md")
        )
        .unwrap(),
        "[[a]]"
    );
    assert_eq!(
        f.send(&s, Method::POST, &format!("/api/operations/{id}"), plan)
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    assert_eq!(f.operation(&s, id).await["status"], "completed");
    let wrong = json!({"moves":[{"from":"reference.md","to":"wrong.md"}],"checks":[],"edits":[]});
    assert_eq!(
        f.send(&s, Method::POST, &format!("/api/operations/{id}"), wrong)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let stale = json!({"moves":[{"from":"reference.md","to":"wrong.md"}],"checks":[{"path":"reference.md","version":"stale"}],"edits":[]});
    let id2 = "22345678123456781234567812345678";
    f.send(&s, Method::POST, &format!("/api/operations/{id2}"), stale)
        .await;
    assert_eq!(f.operation(&s, id2).await["status"], "failed");
    assert!(f.file("reference.md").exists());
}

#[tokio::test]
async fn partial_relocation_records_completed_moves_and_raw_backup() {
    let f = Fixture::new();
    let s = f.login().await;
    let raw = b"first\r\nsecond\n";
    fs::write(f.file("mixed.md"), raw).unwrap();
    let note = body(
        f.send(&s, Method::GET, "/api/note?path=mixed.md", Value::Null)
            .await,
    )
    .await;
    let id = "32345678123456781234567812345678";
    let plan = json!({"moves":[{"from":"mixed.md","to":"moved.md"}],"checks":[],"edits":[{"path":"mixed.md","target":"moved.md","content":"rewritten","expectedVersion":note["version"]}]});
    f.send(&s, Method::POST, &format!("/api/operations/{id}"), plan)
        .await;
    let op = f.operation(&s, id).await;
    assert_eq!(op["status"], "failed");
    assert_eq!(op["completedMoves"][0]["to"], "moved.md");
    assert_eq!(fs::read(f.file("moved.md")).unwrap(), raw);
    assert_eq!(
        fs::read(f.root.path().join("data/backups").join(id).join("mixed.md")).unwrap(),
        raw
    );
}

#[tokio::test]
async fn interrupted_operation_is_reported_after_restart_without_replaying_moves() {
    let mut f = Fixture::new();
    let s = f.login().await;
    fs::write(f.file("a.md"), "A").unwrap();
    fs::write(f.file("c.md"), "C").unwrap();
    let id = "42345678123456781234567812345678";
    f.send(
        &s,
        Method::POST,
        &format!("/api/operations/{id}"),
        json!({"moves":[{"from":"a.md","to":"b.md"}],"edits":[],"checks":[]}),
    )
    .await;
    assert_eq!(f.operation(&s, id).await["status"], "completed");
    let path = f
        .root
        .path()
        .join("data/operations")
        .join(format!("{id}.json"));
    let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["status"] = json!("running");
    record["pendingMove"] = json!({"from":"c.md","to":"d.md"});
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    f.app = app(Server::open(f.config()).unwrap());
    let s = f.login().await;
    let result = f.operation(&s, id).await;
    assert_eq!(result["status"], "interrupted");
    assert_eq!(result["completedMoves"][0]["to"], "b.md");
    assert_eq!(result["pendingMove"]["from"], "c.md");
    assert!(f.file("b.md").exists());
    assert!(f.file("c.md").exists());
    assert!(!f.file("d.md").exists());
}

#[tokio::test]
async fn batch_snapshot_reuses_versions_and_reports_missing_files() {
    let f = Fixture::new();
    let s = f.login().await;
    fs::write(f.file("a.md"), "A").unwrap();
    let initial = body(
        f.send(
            &s,
            Method::POST,
            "/api/snapshot",
            json!({"notes":[{"path":"a.md","version":""}]}),
        )
        .await,
    )
    .await;
    let version = &initial["notes"][0]["version"];
    let next = body(f.send(&s, Method::POST, "/api/snapshot", json!({"notes":[{"path":"a.md","version":version},{"path":"missing.md","version":"old"},{"path":".private/secret.md","version":""}]})).await).await;
    assert_eq!(next["unchanged"], json!(["a.md"]));
    assert_eq!(next["notes"], json!([]));
    assert_eq!(next["errors"].as_array().unwrap().len(), 2);
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_aliases_cannot_expose_private_or_outside_files() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let s = f.login().await;
    fs::write(f.root.path().join("secret.md"), "secret").unwrap();
    symlink(f.root.path().join("secret.md"), f.file("alias.md")).unwrap();
    assert_eq!(
        f.send(&s, Method::GET, "/api/note?path=alias.md", Value::Null)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
}


#[tokio::test]
async fn canvas_http_uses_shared_versions_limits_and_relocation_jobs() {
    let f=Fixture::new();let session=f.login().await;
    let response=f.send(&session,Method::POST,"/api/note",json!({"path":"a.canvas","content":"{\"nodes\":[],\"edges\":[]}"})).await;
    assert_eq!(response.status(),StatusCode::OK);
    let note=body(response).await;
    let response=f.send(&session,Method::PUT,"/api/note?path=a.canvas",json!({"content":"{\"nodes\":[],\"edges\":[],\"label\":\"new\"}","expectedVersion":note["version"]})).await;
    assert_eq!(response.status(),StatusCode::OK);
    let saved=body(response).await;
    assert_eq!(f.send(&session,Method::PUT,"/api/note?path=a.canvas",json!({"content":"{}","expectedVersion":note["version"]})).await.status(),StatusCode::CONFLICT);
    assert_eq!(f.send(&session,Method::POST,"/api/note",json!({"path":"a.json","content":"{}"})).await.status(),StatusCode::BAD_REQUEST);
    assert_eq!(f.send(&session,Method::POST,"/api/note",json!({"path":"big.canvas","content":"x".repeat(noto_core::MAX_CANVAS_BYTES+1)})).await.status(),StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!f.file("big.canvas").exists());
    assert_eq!(f.send(&session,Method::POST,"/api/note",json!({"path":"invalid.canvas","content":"{bad"})).await.status(),StatusCode::UNPROCESSABLE_ENTITY);
    let too_many=json!({"nodes":vec![Value::Null;1001]}).to_string();
    assert_eq!(f.send(&session,Method::POST,"/api/note",json!({"path":"too-many.canvas","content":too_many})).await.status(),StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!f.file("too-many.canvas").exists());
    let plan=json!({"moves":[{"from":"a.canvas","to":"b.canvas"}],"edits":[{"path":"a.canvas","target":"b.canvas","content":saved["content"],"expectedVersion":saved["version"]}],"checks":[{"path":"a.canvas","version":saved["version"]}]});
    let response=f.send(&session,Method::POST,"/api/operations/cccccccccccccccccccccccccccccccc",plan.clone()).await;
    let status=response.status();let response_body=body(response).await;assert!(status.is_success(), "{status}: {response_body}");
    let op=f.operation(&session,"cccccccccccccccccccccccccccccccc").await;assert_eq!(op["status"],"completed");
    assert!(!f.file("a.canvas").exists());assert!(f.file("b.canvas").exists());
    assert!(f.send(&session,Method::POST,"/api/operations/cccccccccccccccccccccccccccccccc",plan).await.status().is_success());
}

#[tokio::test]
async fn drawing_http_reuses_auth_versions_limits_and_durable_raw_backups(){
    let f=Fixture::new();let session=f.login().await;
    let source=json!({"type":"noto-drawing","version":1,"background":"#ffffff","elements":[{"id":"a","type":"arrow","x":100,"y":100,"width":-80,"height":-40,"strokeColor":"#123456","strokeWidth":4}]}).to_string();
    let response=f.send(&session,Method::POST,"/api/note",json!({"path":"a.drawing","content":source})).await;assert_eq!(response.status(),StatusCode::OK);let created=body(response).await;
    let next=source.replace("#123456","#654321");
    let response=f.send(&session,Method::PUT,"/api/note?path=a.drawing",json!({"content":next,"expectedVersion":created["version"]})).await;assert_eq!(response.status(),StatusCode::OK);let saved=body(response).await;
    assert_eq!(f.send(&session,Method::PUT,"/api/note?path=a.drawing",json!({"content":source,"expectedVersion":created["version"]})).await.status(),StatusCode::CONFLICT);
    assert_eq!(f.send(&session,Method::PUT,"/api/note?path=a.drawing",json!({"content":"{bad","expectedVersion":saved["version"]})).await.status(),StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(fs::read_to_string(f.file("a.drawing")).unwrap(),next);
    for (name,content,status) in [
        ("invalid.drawing","{}".to_owned(),StatusCode::UNPROCESSABLE_ENTITY),
        ("wrong.drawing",r#"{"type":"drawing","version":2,"elements":[]}"#.to_owned(),StatusCode::UNPROCESSABLE_ENTITY),
        ("huge.drawing","x".repeat(noto_core::MAX_DRAWING_BYTES+1),StatusCode::PAYLOAD_TOO_LARGE),
        ("arbitrary.json",source.clone(),StatusCode::BAD_REQUEST)
    ]{
        assert_eq!(f.send(&session,Method::POST,"/api/note",json!({"path":name,"content":content})).await.status(),status);assert!(!f.file(name).exists());
    }
    let invalid_points=json!({"type":"noto-drawing","version":1,"background":"#ffffff","elements":[{"id":"p","type":"pencil","x":0,"y":0,"width":1,"height":1,"strokeColor":"#123456","points":vec![[0,0];10001]}]}).to_string();
    assert_eq!(f.send(&session,Method::POST,"/api/note",json!({"path":"points.drawing","content":invalid_points})).await.status(),StatusCode::PAYLOAD_TOO_LARGE);
    let plan=json!({"moves":[{"from":"a.drawing","to":"folder/b.drawing"}],"edits":[{"path":"a.drawing","target":"folder/b.drawing","content":next,"expectedVersion":saved["version"]}],"checks":[{"path":"a.drawing","version":saved["version"]}]});
    let id="dddddddddddddddddddddddddddddddd";
    assert!(f.send(&session,Method::POST,&format!("/api/operations/{id}"),plan.clone()).await.status().is_success());
    let operation=f.operation(&session,id).await;assert_eq!(operation["status"],"completed");assert!(!f.file("a.drawing").exists());
    assert_eq!(fs::read(f.root.path().join(format!("data/backups/{id}/a.drawing"))).unwrap(),next.as_bytes());
    assert_eq!(fs::read_to_string(f.file("folder/b.drawing")).unwrap(),next);
    assert!(f.send(&session,Method::POST,&format!("/api/operations/{id}"),plan).await.status().is_success());
    let response=f.send(&session,Method::GET,"/api/note?path=folder%2Fb.drawing",Value::Null).await;assert_eq!(body(response).await["content"],next);
}

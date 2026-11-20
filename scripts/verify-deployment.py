"""Isolated HTTPS/backup verification. Requires the .noto-test-fixture vault marker."""
import base64
import hashlib
import http.cookiejar
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

if len(sys.argv) != 6 or sys.argv[1] not in ('seed', 'check', 'recover-trash', 'write-after-upgrade'):
    raise SystemExit('Usage: python3 scripts/verify-deployment.py <seed|check|recover-trash|write-after-upgrade> <https-origin> <password-file> <test-vault> <CA-file>')
mode, origin, password_file, vault_arg, ca_file = sys.argv[1:]
vault = Path(vault_arg)
if not (vault / '.noto-test-fixture').is_file():
    raise SystemExit('Refusing to mutate a vault without .noto-test-fixture')
if not origin.startswith('https://'):
    raise SystemExit('This verification requires HTTPS')
origin = origin.rstrip('/')
context = ssl.create_default_context(cafile=ca_file)
cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context), urllib.request.HTTPCookieProcessor(cookies))
csrf = ''
def request(route, method='GET', value=None, expected=200, body=None, content_type=None, headers=None):
    options = {'Origin': origin}
    if csrf: options['X-Noto-Csrf'] = csrf
    if value is not None:
        body = json.dumps(value, ensure_ascii=False).encode()
        options['Content-Type'] = 'application/json'
    if content_type: options['Content-Type'] = content_type
    options.update(headers or {})
    req = urllib.request.Request(origin + route, method=method, data=body, headers=options)
    try: response = opener.open(req, timeout=30)
    except urllib.error.HTTPError as error: response = error
    data = response.read()
    assert response.status == expected, (method, route, response.status, data.decode(errors='replace')[:200])
    return data, response.headers
def api(route, method='GET', value=None, expected=200, **kwargs):
    data, headers = request(route, method, value, expected, **kwargs)
    return json.loads(data) if data else None
def query(path): return '?path=' + urllib.parse.quote(path, safe='')
def all_entries(items):
    result = []
    for item in items:
        if item['isDirectory']: result.extend(all_entries(item['children']))
        else: result.append(item['path'])
    return result
def digest(file): return hashlib.sha256(file.read_bytes()).hexdigest()

api('/api/entries', expected=401)
login, headers = request('/api/login', 'POST', {'password': Path(password_file).read_text().strip()})
identity = json.loads(login); csrf = identity['csrf']
cookie = headers.get('Set-Cookie', '').lower()
assert 'secure' in cookie and 'httponly' in cookie and 'samesite=strict' in cookie, 'HTTPS cookie flags missing'
assert api('/api/session')['vaultId'] == identity['vaultId']
request('/api/directory', 'POST', {'path': '不应创建'}, 403, headers={'Origin': 'https://unrelated.invalid'})
request('/api/directory', 'POST', {'path': '不应创建'}, 403, headers={'X-Noto-Csrf': 'invalid'})
ledger_path = vault / '.noto-deployment-test.json'

if mode == 'seed':
    if ledger_path.exists(): raise SystemExit('Seed already exists; use check or prepare another isolated fixture')
    prefix = '部署验收-' + uuid.uuid4().hex[:6]
    api('/api/directory', 'POST', {'path': prefix}, 204)
    api('/api/note', 'POST', {'path': prefix + '/准备.md', 'content': '# 部署验收\n\n[[欢迎]]\n'})
    task = '<!-- noto:task-category -->\n\n# 验收\n\n- [ ] 备份恢复任务\n  - 开始日期：2026-11-14\n  - 结束日期：2026-11-15\n  - 备注：验证 **Markdown** 与 [链接](https://example.com)。\n'
    api('/api/note', 'POST', {'path': '任务/工作/' + prefix + '.md', 'content': task})
    png = (vault / '项目/attachments/示例.png').read_bytes()
    boundary = 'noto-' + uuid.uuid4().hex
    multipart = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="验收图片.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + png + f'\r\n--{boundary}--\r\n'.encode())
    link = api('/api/attachment' + query(prefix + '/准备.md'), 'POST', body=multipart, content_type='multipart/form-data; boundary=' + boundary)
    params = urllib.parse.urlencode({'note': prefix + '/准备.md', 'link': link})
    downloaded, download_headers = request('/api/attachment?' + params)
    assert downloaded == png and 'attachment' in download_headers.get('Content-Disposition', '')
    before = api('/api/note' + query(prefix + '/准备.md'))
    api('/api/note' + query(before['path']), 'PUT', {'content': before['content'] + f'\n![验收]({link})\n', 'expectedVersion': before['version']})
    paths = [path for path in all_entries(api('/api/entries')) if path.lower().endswith(('.md', '.markdown'))]
    snapshot = api('/api/snapshot', 'POST', {'notes': [{'path': path, 'version': ''} for path in paths]})
    operation_id = uuid.uuid4().hex
    plan = {'moves': [{'from': prefix + '/准备.md', 'to': prefix + '/说明.md'}], 'edits': [], 'checks': [{'path': note['path'], 'version': note['version']} for note in snapshot['notes']]}
    api('/api/operations/' + operation_id, 'POST', plan, 202)
    for _ in range(100):
        operation = api('/api/operations/' + operation_id)
        if operation['status'] not in ('queued', 'running'): break
        time.sleep(.1)
    assert operation['status'] == 'completed', operation
    api('/api/note', 'POST', {'path': prefix + '/待恢复.md', 'content': '回收站中的原文\n'})
    api('/api/item' + query(prefix + '/待恢复.md'), 'DELETE', expected=204)
    trashed = next(item for item in api('/api/trash') if item['path'] == prefix + '/待恢复.md')
    ledger = {'serverId': identity['serverId'], 'vaultId': identity['vaultId'], 'operationId': operation_id, 'trashId': trashed['id'], 'trashPath': trashed['path'], 'files': {str(file.relative_to(vault)): digest(file) for file in vault.rglob('*') if file.is_file()}}
    ledger_path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'seeded': True, 'https': origin, 'files': len(ledger['files']), 'uploadDownload': True, 'secureCookie': True, 'originCsrf': True, 'operation': operation['status']}, ensure_ascii=False))
else:
    ledger = json.loads(ledger_path.read_text(encoding='utf-8'))
    assert (ledger['serverId'], ledger['vaultId']) == (identity['serverId'], identity['vaultId']), 'Persistent service/vault identity changed'
    for relative, expected_hash in ledger['files'].items():
        # recover-trash intentionally moves its bytes out of .noto-trash.
        if mode == 'recover-trash' and relative.startswith('.noto-trash/'): continue
        assert digest(vault/relative) == expected_hash, 'File bytes changed: ' + relative
    operation = api('/api/operations/' + ledger['operationId'])
    assert operation['status'] == 'completed'
    if mode == 'recover-trash':
        api('/api/trash/' + ledger['trashId'] + '/restore', 'POST', expected=204)
        assert api('/api/note' + query(ledger['trashPath']))['content'] == '回收站中的原文\n'
    elif mode == 'write-after-upgrade':
        api('/api/note', 'POST', {'path': '升级后新增.md', 'content': '# 升级后新增\n\n回滚镜像后也应保留。\n'})
    else:
        assert any(item['id'] == ledger['trashId'] for item in api('/api/trash'))
    print(json.dumps({'verified': mode, 'https': origin, 'files': len(ledger['files']), 'identityPreserved': True, 'operation': operation['status']}, ensure_ascii=False))

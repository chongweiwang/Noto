# Noto 标识

`desktop/public/noto-mark.svg` 是网页和标题栏使用的源文件；`source.svg` 是相同的桌面图标源，`icon.ico` 和 `32x32.png` 由 Tauri CLI 生成。

修改源文件后，在 `desktop` 目录执行以下 PowerShell 命令，同步桌面资源：

```powershell
npx.cmd tauri icon public/noto-mark.svg --output ../.local/noto-brand-generated
Copy-Item public/noto-mark.svg src-tauri/icons/source.svg
Copy-Item ../.local/noto-brand-generated/icon.ico src-tauri/icons/icon.ico
Copy-Item ../.local/noto-brand-generated/32x32.png src-tauri/icons/32x32.png
```

`build.rs` 跟踪这两个生成的桌面图标，改动后会重新编译程序资源。

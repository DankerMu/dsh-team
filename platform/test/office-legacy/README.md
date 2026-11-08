# Legacy Office conversion fixtures

These are test data for the user-image Docker case that converts DOC, XLS and PPT with DSH's bundled WASM LibreOffice engine (task 17.4, #432). They are not platform code.

| File        | Content                                                                             | Generated from |
| ----------- | ----------------------------------------------------------------------------------- | -------------- |
| `probe.doc` | MS Word 97 binary; one paragraph `旧格式探针 DOC：关于开展年度检查的通知`           | `probe.fodt`   |
| `probe.xls` | MS Excel 97 binary; sheet `报表`: `旧格式探针 XLS：部门`, `金额` / `综合科`, `1234` | `probe.fods`   |
| `probe.ppt` | MS PowerPoint 97 binary; one slide with the text `旧格式探针 PPT：工作汇报`         | `probe.fodp`   |

The Flat ODF sources were written by hand. The binaries were produced on 2026-11-07 by LibreOffice 7.4.7.2 (Debian bookworm `libreoffice-writer-nogui`, `libreoffice-calc-nogui` and `libreoffice-impress-nogui` in `debian:bookworm-slim`), with:

```sh
soffice --headless --convert-to "doc:MS Word 97" probe.fodt
soffice --headless --convert-to "xls:MS Excel 97" probe.fods
soffice --headless --convert-to "ppt:MS PowerPoint 97" probe.fodp
```

Replace a binary only by regenerating it from its source the same way, and update the digests below in the same change.

| File         | sha256                                                             |
| ------------ | ------------------------------------------------------------------ |
| `probe.fodt` | `f5efb57acb5c40a79e38105e6c3675d3d20d04aa9e33b04b25b9e5bf553ba5b5` |
| `probe.fods` | `6f5b7e9b8b82e894ca185566f6bbb4d09b97fb788c67e7b75862dd025b4bc91c` |
| `probe.fodp` | `9ea79fd90caeb5c93490948913a1dd8982bcd2f7f2961de45826b7641f0d4c65` |
| `probe.doc`  | `dd1721dbab058011625c8d19757361893b38df5c795ce45f2b357ef9db9f9aa3` |
| `probe.xls`  | `272ce2ff747bd538b55a19e7614f9fe8932e79806c927b66ffc476d40a93a02c` |
| `probe.ppt`  | `4c1ad7ac48a108f94f04d4370112f3791107b242d022c6cfe716bfc3313b8767` |

## 改了什么 / 为什么

<!-- 一两句话;关联的 plan / issue -->

## 验证

<!-- 自动:npm test / typecheck / 打包校验结果;人工:执行了哪些 gate、结果 -->

## 核对

- [ ] **CLAUDE.md 同步**:本 PR 若改到录音拓扑、STT 引擎与路由、`src/` 顶层结构、用户可见能力、打包 / 发布拓扑之一,已在本 PR 内更新 `CLAUDE.md`(否则勾选并注明"不涉及")。
- [ ] **人工 gate**:涉及硬件、VS Code 生命周期、Windows 策略、真实音频、插入 UX 或安装发布的改动,已按 `docs/manual-gates.md` 执行相关项并在上方写明结果;或注明"不涉及"。**CI 绿 ≠ 人工 gate 已过。**

export default `
# 副作用边界（派发 Agent 铁律）

Flow/task 内允许：读、探索、worktree 编辑、本地提交（disposable 分支）、跑测试——本机可逆操作。
Flow/task 一律不做：git push、PR 创建/合并、issue 写入、tag 推送、workspace 文档落盘、入库、父仓指针——一切出机器/进权威库的操作由编排者经闸门 task（push / create-pr）显式派发。
Flow 终点 = 本地分支/产物 + 结构化报告。
`

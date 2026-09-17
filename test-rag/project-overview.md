# Future-Chat 项目概览

Future-Chat 是我们团队内部的对话式 AI 应用，面向内部知识问答与工具调用场景。本文件是测试知识库的组成部分。

## 一、基本标识

- 项目内部代号：**FC-6035**
- 当前版本：**v3.4.1-rc7**（发布候选版本，rc 编号从 1 开始递增）
- 知识库负责人：**岑知远**
- 文档最后更新：2026 年 3 月

## 二、技术栈

- 前端：Next.js 15 + React 19 + Zustand
- 后端：Next.js Route Handlers（Node 运行时）
- 数据库：PostgreSQL 16
- 模型接入：SiliconFlow（对话模型与 Embedding 模型走同一个 Provider）
- 流式协议：SSE（Server-Sent Events），工具调用状态通过 tool_call / tool_result 事件下发

## 三、环境与角色

- 测试环境统一使用内部角色：**amber-ops**
- 该角色权限包括：读写测试知识库、查看测试环境日志、触发测试环境数据重建
- 生产环境不开放该角色

## 四、说明

本文件仅用于验证私有知识库检索链路。文中所有代号、端口、版本号、人名均为虚构，不对应任何真实系统。

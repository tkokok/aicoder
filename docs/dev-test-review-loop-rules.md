# Dev / Test / Review 循环执行规则

> 记录 AICoder Pipeline 中 `dev → test → review` 阶段的循环原则。
> 这些规则以自然语言形式写入 playbook 的 `EXECUTION RULES`，由 AICoder 主 Agent 自主识别、判断和执行；控制面/数据面仅做进度监控，不再硬编码阶段流转逻辑。

---

## 核心原则

### 1. 必经路径
- `dev` 完成后 **必须** 进入 `test`（只要 `stage_order` 包含 `test`）。
- **不允许** 从 `dev` 直接跳过 `test` 进入 `review`。

### 2. Test 失败后的回流
- `test` 完成后，AICoder 读取 `{run_dir}/test.json`。
- 若满足以下任一条件，**必须** 回到 `dev` 修复：
  - `failed_tests` 数组非空（有测试用例执行失败）
  - `gaps` 数组中包含 `severity` 为 `critical` 或 `high` 的项

### 3. Review 不通过后的回流
- `review` 完成后，AICoder 读取 `{run_dir}/review.json`。
- 若 `approved !== true`，**必须** 回到 `dev` 修复。

### 4. Rework 上下文（二次及以上的 dev）
- 当 `dev` 是第 2 次或更多次执行时，必须在发送给 `dev` subagent 的 prompt **顶部** 追加 `REWORK` 上下文：
  - 说明当前是第几次迭代
  - 说明回流原因（来自 `test` 还是 `review`）
  - 给出原因摘要（如 `failed_tests`、`gaps`、`blockers`、`issues` 的简要概括）

### 5. 二次 dev 后的路径约束
- 任何 rework `dev` 完成后，**仍然必须** 再次进入 `test`。
- **不允许** 从二次 `dev` 直接跳到 `review`。

### 6. 最大迭代次数
- `dev → test → review` 整体循环最多 **3 次迭代**。
- 若即将开始第 4 次 `dev`，AICoder 必须输出：
  ```
  ❌ Pipeline halted: max dev/test/review iterations exceeded.
  ```
  并停止执行，返回 `status: "failed"`。

---

## 正常流转示例（Standard Mode）

```
clarify → design → dev#1 → test#1 → review#1 → completed
                              ↓           ↓ (approved=false)
                              └─────→ dev#2 ←────────┘
                              ↑
                              └ (test failures)
                              │
                              └──→ test#2 → review#2 → completed
```

## 异常流转示例（超限）

```
dev#1 → test#1(失败) → dev#2 → test#2(失败) → dev#3 → test#3(失败)
                                                       ↓
                                              ❌ Halted (iteration 4)
```

---

## 与控制面/数据面的关系

- **控制面**：创建 session 时预生成完整 playbook，一次性下发；不再拆分 phase。
- **数据面**：监听文件系统出现 `{stage}.json` 即认为该阶段完成，更新进度并通知控制面；不干预下一阶段是哪个。
- **AICoder 主 Agent**：playbook 的唯一执行者，负责读取前序阶段输出、决定循环/跳转/停止。

---

## 相关文件

- `server/prompts/pipeline-dispatch.ts` — playbook 生成器，循环规则写入 `EXECUTION RULES`
- `agents/AICoder.md` — AICoder 主 Agent 的 system prompt，约束其必须遵守 playbook 规则
- `server/data/pipeline.ts` / `server/pipeline.ts` — 文件监控与进度上报逻辑（无循环状态机）

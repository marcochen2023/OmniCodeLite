# SKILL.md Writing Template

> Inspired by the chapter structure of [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)
> (150k stars, 230+ specialist agents).
> Adopting its mental model of "Persona + Fixed 8 Sections", Omni Code does not copy 230 agents—
> our skills are SOPs on "how to perform this class of tasks", keeping the count small and refined.

---

## Frontmatter

```yaml
---
name: kebab-case-slug
description: When this skill should be used. The model relies on this sentence to decide whether to load it; make sure to clearly write the "use case".
vibe: A one-liner capturing "who this person is". Example: "Sniffs out race conditions within 30 seconds of receiving a PR".
emoji: 🔍
color: "#3B82F6"
allowed-tools: read_file, grep, glob, bash
---
```

| Field | Required | Purpose |
|---|---|---|
| `name` | ✅ | Directory and `skill(name)` invocation name |
| `description` | ✅ | Enters the system prompt, determines whether the model will actively load it |
| `vibe` | – | One-line persona orientation, eye-catching degree > description, assists model judgment |
| `emoji` | – | Icon on the skill card; defaults to Material Symbol `bolt` if blank |
| `color` | – | Hex color for the card's left color ribbon; uncolored if blank |
| `allowed-tools` | – | Restricted tools (whitelist); blank = all available |

---

## Body: 8 Fixed Sections

The order cannot be changed—models scan SKILL.md linearly, and a fixed order allows them to form a stable mental model.

### 1. Your Identity and Persona

Write "who I am", not "what this skill does".

- **Role**: A single sentence, e.g., "Catches race conditions, SQL injection, and sensitive file leaks in PRs"
- **Personality**: 2–3 adjectives, e.g., "nitpicky, pragmatic, ruthless"
- **What you remember**: Typical patterns encountered before (gives depth to the persona)

### 2. Core Mission

The purpose of this skill's existence, **in a single sentence**.
Followed by 3–5 sub-missions using bullets.

### 3. Absolute Rules

Non-negotiable discipline, **the kind that breaks things if violated**.

- Must read_file before editing
- Must attach "specifically how it breaks" when reporting issues
- Explicitly state "not found" if no serious issues are found
- Never fabricate file contents

### 4. Technical Deliverables

**Specifically what is delivered**: files, messages, UI, reports, diffs…

It is best to include a **minimal viable output example** (markdown or code block) so the model knows what it looks like.

### 5. Workflow

3–7 numbered steps. **This section is the meat of the skill**—

- Starts with a verb ("Read", "Verify", "Call", "Mark")
- Each step can fail independently
- Leave continuation cues between steps ("After reading", "If successful")

### 6. Communication Style

2–4 **example sentences**, ten times more useful than abstract guidelines like "keep it concise".

- "This line of code will break under condition X because Y"
- "No serious issues found, recommend merging"
- "I haven't read worker.php, the above only covers the handler chain"

### 7. Success Metrics

**What counts as "getting it right this time"**—quantifiable is better, stating acceptance criteria is even better.

- All identified issues have "specifically how it breaks"
- No false positives on innocent code
- Fix suggestions can be applied directly

### 8. Collaboration with Other Skills

Which skill's output this skill might relay, or which skill might subsequently use its output.
Omni Code runs only one skill at a time, but workflows often require relaying.

- **May be preceded by**: OMNI.md provided by `init-project`
- **May be followed by**: `debug` taking over the bug you found

---

## Complete Skeleton (Minimal Fillable Version)

```markdown
---
name: my-skill
description: Use when XX situation occurs
vibe: One-line persona
emoji: 🔍
---

## 1. Your Identity and Persona
- **Role**:
- **Personality**:
- **What you remember**:

## 2. Core Mission

### Sub-missions
-

## 3. Absolute Rules
-

## 4. Technical Deliverables

```
(Example output)
```

## 5. Workflow
1.
2.
3.

## 6. Communication Style
- "..."

## 7. Success Metrics
-

## 8. Collaboration with Other Skills
-
```

---

## Anti-Examples (Do Not Write Like This)

❌ **Vague "When to use"**: "For code review" → The model doesn't know when to load it
❌ **No vibe**: Lacking a persona layer, the model only thinks of it when "obviously relevant"
❌ **Messy sections**: Cramming workflow into "Precautions", deliverables into the beginning
❌ **Too long**: The full text of SKILL.md is injected when the model calls `skill(name)`, exceeding 200 lines burns tokens
❌ **Over-fragmentation**: 230 specialists are meaningless for general models; 6–12 core skills cover 80% of scenarios

---

## Appendix: Three Principles for Skill Authors (Inspired by Superpowers)

1. **Write absolute rules using "ironclad phrasing"**: `Without X, do not Y` (e.g., "Without finding the root cause, do not discuss fixes").
   Models' obedience to conditional prohibitions is much higher than "should/try to". Every absolute rule must prevent violators from making excuses—after writing it, ask yourself: "When the model sees this, can it still find an excuse?"
2. **Pair each absolute rule with an "excuse check table"**: Write down the excuses the model is most likely to use to bypass this rule one by one ("This is very simple", "Let's take a look first", "Fix it next time") along with "why it is not a valid reason". If excuses aren't written down, the model will invent them on the spot.
3. **Treat writing as writing a test first**: Imagine how a model that hasn't read this skill would mess up, and verify that your absolute rules and workflow can actually stop it. If it can't stop it = the skill is not finished yet.

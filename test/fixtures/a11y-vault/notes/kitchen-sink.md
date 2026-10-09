---
title: Kitchen Sink
status: active
priority: high
tags: [sample, accessibility]
overflow_01: value
overflow_02: value
overflow_03: value
overflow_04: value
overflow_05: value
overflow_06: value
overflow_07: value
overflow_08: value
overflow_09: value
overflow_10: value
overflow_11: value
overflow_12: value
overflow_13: value
overflow_14: value
overflow_15: value
overflow_16: value
overflow_17: value
overflow_18: value
overflow_19: value
overflow_20: value
overflow_21: value
overflow_22: value
overflow_23: value
overflow_24: value
overflow_25: value
---

# Kitchen Sink

Every Markdown element the web view renders, so the accessibility test sees
each one in both themes. Plain paragraph text with **bold**, *italic*,
~~strikethrough~~, ==highlight==, `inline code`, an [external link](https://example.com),
a [relative link](../diary/2026-01-15.md), and a [[diary/2026-01-15|wiki link]].

## Headings

### Third level

#### Fourth level

##### Fifth level

###### Sixth level

## Lists

- Bullet one
  - Nested bullet
- Bullet two

1. First
2. Second

- [ ] Open task 🔺 📅 2026-01-20 #topic/sample
- [ ] Scheduled task 🔽 ⏳ 2026-01-18
- [ ] Read [the journal](../diary/2026-01-15.md "📔 journal") 🔼
- [x] Done task ✅ 2026-01-14
- [-] Cancelled task ❌ 2026-01-14

## Quote and rule

> A plain blockquote with a [link inside it](https://example.com) and `code`.

---

## Table

| Column | Value | Note |
| --- | ---: | --- |
| Alpha | 1 | [link](https://example.com) |
| Beta | 22 | `code` |

## Code

```javascript
// A highlighted code block
const answer = { value: 42, label: 'answer' };
console.log(answer);
```

## Callouts

> [!note] Note callout
>
> Body text with a [link](https://example.com).

> [!tip] Tip callout
>
> Body text.

> [!warning] Warning callout
>
> Body text.

> [!danger] Danger callout
>
> Body text.

> [!success] Success callout
>
> Body text.

> [!question] Question callout
>
> Body text.

> [!example] Example callout
>
> Body text.

> [!quote] Quote callout
>
> Body text.

> [!info]- Collapsed info callout
>
> Hidden until opened, with a [link](https://example.com).

> [!abstract]- Collapsed abstract callout
>
> - Hidden list item

> [!todo]- Collapsed todo callout
>
> Hidden body.

## Details element

<details>
<summary>Plain HTML details</summary>

Content inside a details element.

</details>

## Footnote

A sentence with a footnote.[^1]

[^1]: The footnote text.

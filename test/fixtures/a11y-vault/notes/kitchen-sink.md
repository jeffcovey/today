---
title: Kitchen Sink
status: active
priority: high
tags: [sample, accessibility]
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

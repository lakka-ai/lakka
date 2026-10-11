# Copy rules

The visible text in the mockups was reviewed line by line. Copy it exactly. Write new text with these rules.

## Characters

- ASCII only. No em dashes, en dashes, curly quotes, ellipsis characters or Unicode arrows.
- No "+" to mean "and". Write "and".
- Use commas, periods or parentheses where you might reach for a dash.
- `scripts/check-copy.sh` catches the character rules: any non-ASCII character, and a "+" between words in UI text. Run it with `pnpm check:copy` before you say a screen is done.

## Voice

- Plain English, short sentences, active voice.
- No buzzwords or marketing phrasing. Say what happens: "Suspend signs a person out everywhere within seconds."
- Sentence case for titles, buttons and labels.
- Buttons are verbs that name the result: "Save cap", "Add a route", "Create key", "Remove provider".

## Messages

- Errors: one sentence on what happened, one on what to do. Never a status code or an exception name.
- Sign-in errors never say which of email and password was wrong.
- Money that was not spent is said plainly: "Nothing was charged."
- Say where things go and who can see them: "Alerts go to the workspace webhook." "Workspace admins can see them in request traces."

## Numbers and dates

- Money: $ and two decimals ($999.60). Per-request costs can use four decimals ($0.0073). An estimate says so and keeps its rounding: "About $335 less a month".
- Counts with thousands separators (6,412).
- Tabular figures wherever numbers line up.
- Dates: "Sep 28". With a time: "Sep 28, 09:14". Times are 24-hour. "Today 14:02" and "Yesterday" are fine for recent items.
- Durations: "4 ms", "2.41 s", "23.9 s".

## Chips

- Under 16 characters in English, so they survive translation.
- The chip is short. Its accessible name, or the popover it opens, carries the full sentence.

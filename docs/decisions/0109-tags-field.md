# 0109. A tags field: values picked from a list, or typed

Status: accepted. Changes ADR 0093 (the alert field's Add button), and the Set a cap
dialog and the allowed email domains in `docs/design/docs/accessibility.md`.

## Context

- The Set a cap dialog took alert percentages as a typed number with an Add button (ADR 0093),
  checked against the api's rule: a whole number from 1 to 100, at most five (BG-10).
- The project owner asked for a HeroUI Autocomplete instead, from 10 to 200 percent in steps of
  10, and then for other values to be typed into it too.
- A sign-in provider's allowed email domains were the same kind of field: a typed domain with
  an Add domain button, checked against the api's rule (a domain name, at most 50; ID-2). The
  project owner asked for the same control there.
- Spend never passes a cap: a request that would is refused before dispatch (BG-2, BG-3). An
  alert above 100 percent could never be sent, and the api refuses one.

## Decision

- **One pattern, `TagsField`**, for a field of values that are tags. It is described below as
  Alert at uses it; Allowed email domains uses it the same way with nothing suggested.
- **Alert at** is a multiple-selection Autocomplete, like the model pickers: a search field over
  the options, a tick on each picked one. The picked ones are tags in the field, each with a
  remove button; Delete removes a focused tag.
- The list offers every 10 percent from 10 to 100. Nothing above 100, for the reason above; the
  project owner agreed.
- Any other whole percentage from 1 to 100 can be typed into the list's search field; it becomes
  an option to pick. Anything else empties the list and says "Enter a whole percentage from 1 to
  100." These are the api's rules, so the field never offers what the api would refuse.
- A picked value off the grid (75, typed or set through the api) stays offered while picked, so it
  shows and can be removed.
- The help text always says the rule: up to five, each a whole percentage from 1 to 100. Once
  five are picked, the other options are disabled until one is removed.
- The picked tags are a small tag, made to fit inside the field: 22px with a 20px Remove button
  (26 and 24 on a phone), so a field of tags is as tall as any other field, 40px (44 on a
  phone), until they wrap. The design's 28px tag stays for tags outside a field.
- A typed value, once picked, clears the search for the next one.
- **Allowed email domains** suggests nothing: a domain is typed, kept in lower case, and checked
  with the api's pattern; anything else says "Enter a domain such as example.com." Empty, the
  field says "Any domain", which is what an empty list means, and its list opens to "Type a
  domain, such as example.com." At most 50, as the api takes.
- The alert field is its own component, `AlertPercentsField`, so the pattern gallery can show it
  without the dialog's api calls.

## Consequences

- The Add buttons and their fields are gone; typing happens in the list's search field.
- Esc in the search field first clears it, then closes the list, as in the model pickers.

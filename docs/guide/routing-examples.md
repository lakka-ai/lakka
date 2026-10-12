# Example routes

These routes are starting points for a workspace's **Routing** page. Each one shows the fields
you fill in under **Add a route**, with a description and example phrasings you can paste
straight into the form, one per line. Copy the ones that fit your team, change the wording to
match how your people write, and check them with **Try a phrase**. How routing decides, and how
accurate it is, is under [Routing](administration.md#routing).

The models are named by what they need, not by product, because your providers and prices are
your own. "The default model" is the workspace's **Default model**: a capable, general model that
answers whatever no route claims. A route is worth adding when its kind of request needs a
stronger model than the default, or can be answered just as well by a cheaper one.

These examples were written for this page. They are not the project's evaluation set and their
accuracy was not measured; your own messages are the real test.

## Before you start

- Start with three or four routes for the requests your team sends most. Add more when
  **When people choose another model** shows people moving away from what routing chose.
- Routes compete with each other. Every route you add takes some messages from its neighbours,
  so give each one a clear, separate job.
- A route whose model is cheaper than the default needs a surer match, so a hard request is not
  sent to a weaker model by mistake. That is why the two values under **How sure routing must be**
  differ. Leave them as they are at first.
- Messages under three words skip the classifier, and a conversation keeps its first decision.

## Code

For a team that writes software. Code needs the strongest model you have, and a code block or a
file name in the message is a near-certain sign, so signals do most of the work here.

| Field                    | Value                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Name                     | `code`                                                                                             |
| Model                    | your strongest coding model                                                                        |
| Fallbacks, in order      | the default model                                                                                  |
| Description              | Writing, reviewing, debugging or explaining code, scripts, SQL, shell commands and error messages. |
| Signals                  | **Code block**, **Source file name**                                                               |
| How sure routing must be | leave as it is                                                                                     |

```text
Why does this function return undefined when the array is empty?
Write a bash script that deletes log files older than 30 days.
Can you review this pull request description and the diff below for bugs?
How do I undo my last commit without losing the changes?
This SQL query takes 40 seconds on a big table, how do I make it faster?
Explain what this stack trace means and where I should start looking.
Convert this Python 2 code to Python 3.
What is the difference between a process and a thread?
Add input validation to this form handler so empty emails are rejected.
I keep getting CORS errors when the frontend calls our API locally, what am I missing?
Write unit tests for the date parsing helper below.
Our Docker build is suddenly twice as slow, what could cause that?
```

A signal sends a message to its route without the classifier, so a pasted traceback in a code
block goes here even when the words around it are vague. Each signal belongs to one route.

## Summaries

Condensing a text someone pasted is easy work. A cheaper, fast model with a long context does it
well and saves money on long inputs.

| Field                    | Value                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Name                     | `summarize`                                                                                           |
| Model                    | a cheaper, fast model with a long context                                                             |
| Fallbacks, in order      | another cheap model, then the default model                                                           |
| Description              | Shortening a pasted document, email thread, transcript or meeting notes into a summary or key points. |
| Signals                  | none                                                                                                  |
| How sure routing must be | leave as it is                                                                                        |

```text
Summarize this email thread in five bullet points.
Give me the key decisions and action items from these meeting notes.
Can you shorten this report to one paragraph for the leadership update?
What are the main points of the article below?
TL;DR this Slack thread, I missed the whole discussion.
Turn this call transcript into a short summary with who agreed to do what.
I need a three sentence version of this press release.
Pull out the deadlines and owners mentioned in this project plan.
Summarize the customer feedback below and group it by theme.
What does this 20 page policy actually say, in plain language?
Make a one page brief from these research notes.
Condense this changelog into what users will notice.
```

Summaries sit close to writing. The description says "pasted" and "shortening" so a request to
write something new does not land here.

## Translation

Translation between common languages is reliable on a cheaper model. Write the examples in
whatever language your team uses; the classifier matches across more than fifty languages.

| Field                    | Value                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| Name                     | `translate`                                                                    |
| Model                    | a cheaper, fast model                                                          |
| Fallbacks, in order      | the default model                                                              |
| Description              | Translating text from one language into another, keeping the meaning and tone. |
| Signals                  | none                                                                           |
| How sure routing must be | leave as it is                                                                 |

```text
Translate this paragraph into German.
How do you say "the invoice is overdue" politely in French?
Can you translate this customer email from Spanish so I understand what they want?
Put our onboarding checklist into Swedish, keep the headings.
Translate the text below to English and keep the formatting.
What does this Japanese error message on the label mean?
Translate these product descriptions into Italian for the shop.
I need this reply in Portuguese, friendly but professional.
Translate this contract clause literally, I will have a lawyer check it.
Give me the Dutch version of this job ad.
Is this Polish sentence a complaint or a question? Translate it please.
Translate the meeting invitation into Danish and Norwegian.
```

## Contracts and privacy

For questions where a wrong answer is costly. The description names concrete things, which
helps the route stand apart from general writing.

| Field                    | Value                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Name                     | `legal`                                                                                     |
| Model                    | your strongest model                                                                        |
| Fallbacks, in order      | the default model                                                                           |
| Description              | Contracts, NDAs, terms of service, GDPR and privacy questions, and reviewing legal clauses. |
| Signals                  | none                                                                                        |
| How sure routing must be | leave as it is                                                                              |

```text
Is there anything unusual in this NDA before I sign it?
Explain the liability clause in this supplier contract.
Do we need a data processing agreement with our email provider under GDPR?
A customer asked us to delete all their data, what do we have to do and by when?
Compare these two versions of the termination clause and tell me what changed.
What should a freelancer contract include about who owns the work?
Can we use customer emails to train an internal tool without asking them?
Draft a short privacy notice for our newsletter sign-up form.
Is a 24 month non-compete clause like this one normal?
What is the difference between a data controller and a data processor?
Review our terms of service for anything that would worry a business customer.
The vendor wants unlimited indemnity, how should we push back?
```

Lakka does not give legal advice and neither does the model; this route only sends these
questions to the model most likely to read the text carefully.

## Customer replies

A route for one team's own work: a support team that drafts many short replies. Routes like this
one, built around how your people actually write, often match better than general ones.

| Field                    | Value                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| Name                     | `support-reply`                                                                                |
| Model                    | a cheaper, fast model                                                                          |
| Fallbacks, in order      | the default model                                                                              |
| Description              | Drafting replies to customer support tickets, complaints, refund requests and order questions. |
| Signals                  | none                                                                                           |
| How sure routing must be | leave as it is                                                                                 |

```text
Write a reply to this customer whose order arrived damaged, offer a replacement.
The customer below is angry about a double charge, draft a calm answer.
Reply to this ticket and explain that refunds take five to seven working days.
Help me answer this customer who cannot log in after resetting their password.
Draft a friendly reply saying the feature they asked for is on our list but has no date.
This customer wants to cancel, write a reply that confirms it and asks why.
Answer this question about shipping to Norway using our usual tone.
Make this support reply shorter and less formal.
The customer says the discount code did not work, write a reply with a new one.
Write a follow-up to a ticket that has had no answer from the customer for a week.
Politely tell this customer we cannot refund a subscription after 30 days.
Rewrite my reply so it sounds less defensive.
```

Written replies would otherwise go to a general writing route or the default model. A cheaper
model is enough because the replies are short and follow a pattern; if people often switch away
from it, **Review** shows which replies they did not trust it with.

## Spreadsheets and data

Questions about numbers need careful reasoning, so this route goes to a stronger model. A file
name such as `sales.csv` is not a code signal: data and document formats are left out, so these
messages are still decided by the classifier.

| Field                    | Value                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Name                     | `data`                                                                                             |
| Model                    | your strongest reasoning model                                                                     |
| Fallbacks, in order      | the default model                                                                                  |
| Description              | Analysing numbers, spreadsheets, CSV files and charts, spreadsheet formulas and simple statistics. |
| Signals                  | none                                                                                               |
| How sure routing must be | leave as it is                                                                                     |

```text
Write a spreadsheet formula that sums column C only where column A says "paid".
Here are our monthly sales figures, which months are unusually low and why might that be?
How do I make a pivot table that shows revenue per region per quarter?
Is the difference between these two conversion rates significant with this sample size?
Clean up this CSV so the dates are all in the same format.
What chart would best show how support tickets changed over the year?
Calculate the average order value and the median from the numbers below.
Our churn went from 3% to 5%, how many customers is that out of 1,200?
Why does my VLOOKUP return #N/A for some rows?
Forecast next quarter from these twelve months of figures and explain the method.
Find the duplicates in this list of customer emails.
Turn this table of expenses into totals per category and month.
```

## Brainstorming

Lists of ideas, names and options do not need the strongest model, and people often ask for
many of them, so a cheaper model keeps the cost down.

| Field                    | Value                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Name                     | `brainstorm`                                                                             |
| Model                    | a cheaper, fast model                                                                    |
| Fallbacks, in order      | the default model                                                                        |
| Description              | Coming up with ideas, names, slogans, topics and options, where many quick answers help. |
| Signals                  | none                                                                                     |
| How sure routing must be | leave as it is                                                                           |

```text
Give me ten name ideas for an internal tool that tracks equipment loans.
What are some fun ideas for a remote team event in December?
Suggest blog post topics about moving a small company to the cloud.
List possible reasons customers stop using a product after the first week.
I need taglines for our spring campaign, short and a bit playful.
Brainstorm questions to ask in a customer interview about onboarding.
What could we call the new premium plan?
Give me twenty ideas for a newsletter subject line about our price change.
Suggest ways to make our weekly meeting less boring.
What are some angles for a talk about privacy for non-technical people?
Come up with icebreaker questions for a workshop with new hires.
List ideas for a small thank-you gift for our beta testers.
```

## Writing your own

**Name.** Lowercase letters, numbers and dashes, up to 40 characters. Replies show it, and API
clients can ask for it by name as `route/<name>`, so pick something people recognise, such as
`code` or `support-reply`.

**Description.** One line, up to 500 characters, on what the route is for. Routing uses it from
the moment you save, before there are any examples, and keeps counting it as one more example
afterwards.

- Name concrete things: "contracts, NDAs, GDPR" does better than "legal stuff".
- Say what sets the route apart from its neighbours: "shortening a pasted document" rather than
  "working with text", which a writing route could claim too.
- Editing the description, or renaming a route that has one, changes where messages go. Check
  with **Try a phrase** after.

**Example phrasings.** Twelve or more, one per line, up to 200 per route.

- Write each line as a whole message a person would send. Routing compares whole messages, so
  "SQL" or "contracts" on their own match little; the page warns when most lines are a word or
  two.
- Vary them: questions and commands, short and long, polite and blunt, with different subjects.
  Twelve lines that all start with "Summarize" teach the route one sentence, not a kind of
  request.
- Use your team's own words. Product names, customer types and internal jargon in the examples
  help messages that use them find the route.
- Include the hard cases at the edge with a neighbouring route, on the side you want them. A
  request to "rewrite this reply so it sounds less defensive" belongs with support replies, not
  general writing, if that is where you want it.
- Leave out requests that would fit two routes equally well. Those are better answered by the
  default model.
- The best examples are real ones. While **Record prompts and replies** is on, **Review** on the
  Routing page lists messages people moved away from, and **Add to a route** starts an example
  from one. Lakka never adds an example on its own.

**Model and fallbacks.** Send a route to a cheaper model only when a weaker answer would still
be good enough for that kind of request. Fallbacks are tried in order when the model is not
available or a budget would not cover it; ending the list with the default model is a safe
choice. A fallback from another provider needs **Fallbacks may use another provider**.

**Signals.** Only for code: **Code block** for a fenced block in the message, and **Source file
name** for a name such as `main.py`. A signal decides without the classifier and works in every
language.

**How sure routing must be.** Leave the defaults until a route misbehaves. If messages that
belong to a route go to the default model, add examples first, then lower the route's values a
little. If a cheap route catches requests it should not, raise **Lowest confidence when the model
is cheaper**. Each change applies to new conversations only.

## A route that does not work

```text
Name:        misc
Model:       a cheaper, fast model
Description: general questions
Examples:    questions
             help
             quick stuff
             misc
```

The description names nothing concrete, so it overlaps every other route. The examples are
keywords, which sit far from any real message, and shorter than any message routing classifies. And
it sends a vague mix of requests to a cheaper model, where a hard one will get a weak answer.
Requests that fit no route already have a home: the default model.

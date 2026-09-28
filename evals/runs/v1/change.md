Require the "not found" prefix as the literal first characters of the response.

Baseline failure: in 2 of 6 unanswerable attempts (unanswerable-eo-limit rep0, unanswerable-auto-fleet-authority rep1) the agent wrote an explanatory paragraph first and put `Not found in the Atlas corpus:` at the start of the second paragraph. The answer content was correct (the claims judge passed both), but `answerStatus()` only recognizes the prefix at the start, so both were classified as answered, which is what a UI or API consuming `status` would see.

Change: the "When the corpus doesn't answer" instruction now says the prefix must be the very first characters with nothing before it, and says why (software reads the opening to classify the answer). The prefix text and the status parser are unchanged, so the grader is unchanged too.

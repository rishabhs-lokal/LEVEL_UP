#!/usr/bin/env python3
"""Parses eaze_swipe_quickplay.md into content/cards.json.

Source structure (fixed):
  ## Session N

  **N. Prompt**
  OptionA  vs  OptionB

  - **Correct swipe:** OptionName
  - **If swiped wrong:** explanation

No topics in this content set — 20 sessions x 15 cards, each card carries its
own option pair (they vary card to card, unlike the old fixed-per-topic
category model).
"""
import json
import re
import sys
from pathlib import Path

SRC = Path("/Users/rishabhvijaysingh/Downloads/eaze_swipe_quickplay.md")
OUT = Path(__file__).resolve().parent.parent / "content" / "cards.json"

SESSION_RE = re.compile(r"^## Session (\d+)$")
CARD_RE = re.compile(r"^\*\*(\d+)\.\s*(.+?)\*\*\s*$")
OPTIONS_RE = re.compile(r"^(.+?)\s+vs\s+(.+?)$")
CORRECT_RE = re.compile(r"^-\s*\*\*Correct swipe:\*\*\s*(.+?)\s*$")
WRONG_RE = re.compile(r"^-\s*\*\*If swiped wrong:\*\*\s*(.+?)\s*$")


def main():
    lines = SRC.read_text(encoding="utf-8").splitlines()

    sessions = []
    session = None
    card = None

    for raw in lines:
        line = raw.rstrip()

        m = SESSION_RE.match(line)
        if m:
            session = {"number": int(m.group(1)), "cards": []}
            sessions.append(session)
            card = None
            continue

        m = CARD_RE.match(line)
        if m and session is not None:
            card = {
                "number": int(m.group(1)),
                "prompt": m.group(2).strip(),
                "optionA": None,
                "optionB": None,
                "correct": None,
                "explanation": None,
            }
            session["cards"].append(card)
            continue

        m = OPTIONS_RE.match(line)
        if m and card is not None and card["optionA"] is None:
            card["optionA"] = m.group(1).strip()
            card["optionB"] = m.group(2).strip()
            continue

        m = CORRECT_RE.match(line)
        if m and card is not None:
            card["correct"] = m.group(1).strip()
            continue

        m = WRONG_RE.match(line)
        if m and card is not None:
            card["explanation"] = m.group(1).strip()
            continue

    errors = []
    total_cards = 0
    if len(sessions) != 20:
        errors.append(f"Expected 20 sessions, found {len(sessions)}")

    for session in sessions:
        if len(session["cards"]) != 15:
            errors.append(f"Session {session['number']} has {len(session['cards'])} cards, expected 15")
        for card in session["cards"]:
            total_cards += 1
            missing = [k for k in ("prompt", "optionA", "optionB", "correct", "explanation") if not card.get(k)]
            if missing:
                errors.append(f"Session {session['number']} card {card['number']} missing {missing}")
                continue
            if card["correct"] == card["optionA"]:
                card["correctOption"] = "A"
            elif card["correct"] == card["optionB"]:
                card["correctOption"] = "B"
            else:
                errors.append(
                    f"Session {session['number']} card {card['number']}: correct swipe "
                    f"'{card['correct']}' matches neither option "
                    f"('{card['optionA']}' / '{card['optionB']}')"
                )
                continue
            card["id"] = f"s{session['number']}-c{card['number']}"
            del card["correct"]
            del card["number"]

    if errors:
        print(f"Found {len(errors)} problem(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Parsed {len(sessions)} sessions, {total_cards} cards total.")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"sessions": sessions}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()

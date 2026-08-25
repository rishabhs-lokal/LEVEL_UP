#!/usr/bin/env python3
"""Parses the eaze_swipe_content.md source doc into content/cards.json.

Source structure (fixed, see Desktop/files/eaze_swipe_content.md):
  ## Topic
  **Category A:** <name>
  **Category B:** <name>
  ### Session N · Title
  **Card N**
  > "scenario text"
  - **Correct swipe:** <Category name>
  - **If swiped wrong:** <explanation>
"""
import json
import re
import sys
from pathlib import Path

SRC = Path("/Users/rishabhvijaysingh/Desktop/files/eaze_swipe_content.md")
OUT = Path(__file__).resolve().parent.parent / "content" / "cards.json"

TOPIC_RE = re.compile(r"^## (?!Contents)(.+)$")
CAT_A_RE = re.compile(r"^\*\*Category A:\*\*\s*(.+?)\s*$")
CAT_B_RE = re.compile(r"^\*\*Category B:\*\*\s*(.+?)\s*$")
SESSION_RE = re.compile(r"^### Session (\d+) · (.+)$")
CARD_RE = re.compile(r"^\*\*Card (\d+)\*\*$")
QUOTE_RE = re.compile(r'^>\s*"(.+)"\s*$')
CORRECT_RE = re.compile(r"^-\s*\*\*Correct swipe:\*\*\s*(.+?)\s*$")
WRONG_RE = re.compile(r"^-\s*\*\*If swiped wrong:\*\*\s*(.+?)\s*$")

TOPIC_SLUGS = {
    "Stress": "stress",
    "Trauma": "trauma",
    "Work": "work",
    "Health": "health",
    "Breakup & Relationship": "breakup-relationship",
    "Low Confidence": "low-confidence",
}


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main():
    lines = SRC.read_text(encoding="utf-8").splitlines()

    topics = []
    topic = None
    session = None
    card = None

    for raw in lines:
        line = raw.rstrip("\n")

        m = TOPIC_RE.match(line)
        if m and not line.startswith("### "):
            name = m.group(1).strip()
            topic = {
                "id": TOPIC_SLUGS.get(name, slugify(name)),
                "name": name,
                "categoryA": None,
                "categoryB": None,
                "sessions": [],
            }
            topics.append(topic)
            session = None
            card = None
            continue

        m = CAT_A_RE.match(line)
        if m and topic:
            topic["categoryA"] = m.group(1)
            continue

        m = CAT_B_RE.match(line)
        if m and topic:
            topic["categoryB"] = m.group(1)
            continue

        m = SESSION_RE.match(line)
        if m and topic:
            session = {
                "number": int(m.group(1)),
                "title": m.group(2).strip(),
                "cards": [],
            }
            topic["sessions"].append(session)
            card = None
            continue

        m = CARD_RE.match(line)
        if m and session:
            card = {"number": int(m.group(1)), "prompt": None, "correct": None, "explanation": None}
            session["cards"].append(card)
            continue

        m = QUOTE_RE.match(line)
        if m and card:
            card["prompt"] = m.group(1)
            continue

        m = CORRECT_RE.match(line)
        if m and card:
            card["correct"] = m.group(1)
            continue

        m = WRONG_RE.match(line)
        if m and card:
            card["explanation"] = m.group(1)
            continue

    # Validate + attach category letter to each card, and a stable global id.
    errors = []
    total_cards = 0
    for topic in topics:
        if not topic["categoryA"] or not topic["categoryB"]:
            errors.append(f"Topic '{topic['name']}' missing category A/B")
        if len(topic["sessions"]) != 10:
            errors.append(f"Topic '{topic['name']}' has {len(topic['sessions'])} sessions, expected 10")
        for session in topic["sessions"]:
            if len(session["cards"]) != 5:
                errors.append(
                    f"Topic '{topic['name']}' session {session['number']} has "
                    f"{len(session['cards'])} cards, expected 5"
                )
            for card in session["cards"]:
                total_cards += 1
                missing = [k for k in ("prompt", "correct", "explanation") if not card.get(k)]
                if missing:
                    errors.append(
                        f"Topic '{topic['name']}' session {session['number']} card "
                        f"{card['number']} missing {missing}"
                    )
                    continue
                if card["correct"] == topic["categoryA"]:
                    card["correctCategory"] = "A"
                elif card["correct"] == topic["categoryB"]:
                    card["correctCategory"] = "B"
                else:
                    errors.append(
                        f"Topic '{topic['name']}' session {session['number']} card "
                        f"{card['number']}: correct swipe '{card['correct']}' matches "
                        f"neither category"
                    )
                card["id"] = f"{topic['id']}-s{session['number']}-c{card['number']}"
                del card["number"]

    if errors:
        print(f"Found {len(errors)} problem(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Parsed {len(topics)} topics, {total_cards} cards total.")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"topics": topics}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()

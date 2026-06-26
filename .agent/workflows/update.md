---
description: Archive the latest walkthrough and update lessons learned in the repository
---

This workflow archives the current conversation's walkthrough file into the workspace's `walkthroughs/` directory and updates the `lessons_learned.md` file with any new development lessons.

1. **Locate the Walkthrough File**:
   - Find the current conversation's `walkthrough.md` file in the artifacts directory.
   - The path is `C:\Users\ChrisFro\.gemini\antigravity-ide\brain\<conversation-id>\walkthrough.md` (substitute the active `Conversation ID` from the metadata).
   - If the file does not exist, notify the user and ask if a walkthrough should be generated first.

2. **Archive the Walkthrough**:
   - Read the contents of `walkthrough.md`.
   - Extract the H1 title of the walkthrough (e.g., `# Walkthrough - Chrome Extension and Backend Auth Alignment` -> `Chrome Extension and Backend Auth Alignment`).
   - Format the filename as `walkthroughs/walkthrough-<title-slug>.md` where `<title-slug>` is the lowercase, alphanumeric, hyphenated version of the title (e.g., `walkthroughs/walkthrough-chrome-extension-and-backend-auth-alignment.md`).
   - Create the `walkthroughs/` directory in the workspace root if it does not exist.
   - Write the walkthrough contents to the new file path in the workspace.

3. **Identify Lessons Learned**:
   - Analyze the modifications made during this conversation (using `git diff` or by reading the walkthrough).
   - Check if there are any new developer mistakes, unexpected bugs, or architectural issues encountered (e.g., circular dependencies, missing fields in webhook payloads, runtime mismatches, etc.).
   - Draft a new entry for `lessons_learned.md` using the exact format:
     - **Title**: A concise title describing the lesson.
     - **What happened**: A concrete description of the issue grounded in actual code.
     - **Root cause**: The underlying reason why it occurred.
     - **Rule going forward**: Directives or checks to prevent it from happening again.

4. **Update `lessons_learned.md`**:
   - Read the current `lessons_learned.md` file in the workspace root.
   - Append the new lessons to the end of the file.
   - Ensure the structure matches the existing document.

5. **Check and Update OSOT Index and Loop Engineering**:
   - Read the OSOT Index ([megamind.md](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/docs/megamind.md)) and Loop Engineering documentation ([loop_engineering.md](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/docs/loop_engineering.md)).
   - Analyze the modifications made in the conversation to see if they affect files listed in the OSOT index, or if they change the status/implementation of any developer, agent, or runtime feedback loops.
   - If any OSOT locations have changed or new architectural topics have been introduced, update [megamind.md](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/docs/megamind.md).
   - If any developer, agent, or runtime feedback loops have been added, modified, activated, or if instructions for their execution have changed, update [loop_engineering.md](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/docs/loop_engineering.md).

6. **Report to User**:
   - Confirm to the user that the walkthrough has been archived and `lessons_learned.md` has been updated.
   - If [megamind.md](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/docs/megamind.md) or [loop_engineering.md](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/docs/loop_engineering.md) were updated, mention these updates as well.
   - Provide links to the newly created walkthrough file, the updated `lessons_learned.md` file, and any other updated markdown documents.

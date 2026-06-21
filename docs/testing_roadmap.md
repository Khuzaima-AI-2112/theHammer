# Manual Testing Roadmap: Side-by-Side Accessibility Capture

This roadmap covers the end-to-end verification of the new Accessibility Tree capture feature. You will be verifying that the extension correctly extracts DOM semantic data (inputs, checkboxes, text selections) and that the backend successfully stores it alongside the screenshot.

## Phase 1: Environment Setup

1. **Start the Backend:**
   Open a terminal in the `backend/` directory and run your local dev server. Ensure you have the necessary environment variables set up for your GCS Bucket and Firebase credentials.
   ```bash
   npm run dev
   ```
2. **Reload the Extension:**
   - Open Chrome and navigate to `chrome://extensions/`.
   - Ensure "Developer mode" is toggled on (top right).
   - Click the reload icon (↻) on **The Hammer** extension card to load the latest changes to `content.js` and `service-worker.js`.

## Phase 2: Core Feature (Happy Path)

1. **Prepare a Test Page:**
   Navigate to any webpage that contains a form (e.g., a login page, a sign-up form, or a simple HTML form test page).
2. **Interact with the Page:**
   - Type some text into an `<input type="text">` or `<textarea>`.
   - Toggle a checkbox or select a radio button.
   - Highlight a specific sentence or paragraph on the page with your mouse.
3. **Trigger the Capture:**
   Click the floating 🔨 Hammer button in the bottom right, or use your keyboard shortcut to capture the screenshot.
4. **Verify GCS Storage:**
   - Navigate to your Google Cloud Storage bucket (or local emulator).
   - Locate the newly uploaded `.png` file.
   - **Crucial Check:** Verify that there is a `.json` file in the exact same directory, with the exact same base name.
   - Open the `.json` file. Ensure it contains an `inputs` array populated with your typed values and checked states, and that the `selection` field contains the text you highlighted.
5. **Verify Firestore:**
   - Open your Firestore database.
   - Navigate to the `uploads` collection and find the latest document.
   - Verify that the `hasSemanticData: true` field is present.

## Phase 3: Fallback Upload Testing

The extension uses a direct-to-GCS upload via signed URLs (`/upload-url`) by default, but falls back to a proxy upload (`/capture`) if that fails. We should test both.
1. **Simulate Fallback:**
   In `service-worker.js`, temporarily break the `/upload-url` route (e.g., by changing the endpoint string to `/upload-url-broken`). Reload the extension.
2. **Trigger Capture:**
   Perform another capture on a page with form inputs.
3. **Verify:**
   Check the backend console logs. You should see it fall back to the proxy upload. Verify that the `.png`, the `.json` file, and the Firestore document are still successfully created.
4. *(Remember to revert the broken URL in `service-worker.js` and reload the extension afterwards!)*

## Phase 4: Edge Cases

1. **No Inputs / Blank Page:**
   - Navigate to a completely blank page or a simple text article with no form elements and no text selected.
   - Trigger a capture.
   - **Expected Result:** The `.json` file should still be uploaded (to keep the 1:1 file mapping), but `inputs` should be an empty array `[]` and `selection` should be an empty string `""`.
2. **Hidden Elements:**
   - Navigate to a page with `display: none` inputs or zero-width/height elements.
   - Trigger a capture.
   - **Expected Result:** The JSON file should safely ignore these hidden elements.
3. **Cross-Origin / Restricted Pages:**
   - Navigate to `chrome://extensions` or the Chrome Web Store.
   - Trigger a capture.
   - **Expected Result:** The extension should fail gracefully or fallback to capturing just the screenshot if the content script (`content.js`) is blocked from running on restricted pages. The backend should handle the absence of `semanticData` cleanly (`hasSemanticData: false`).

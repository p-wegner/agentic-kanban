/**
 * Helpers for pasting clipboard images into a description editor.
 *
 * The detail-panel edit flow (useIssueEditForm / IssueDetailPanel) and the
 * create-issue forms (CreateIssueForm / CreateIssuePanel) all let the user
 * paste a screenshot straight into the description. The image is read as a
 * data URL, previewed as a removable thumbnail, and on submit appended to the
 * description as markdown — this module is the single source of that contract.
 */

/**
 * Extract the first image found in a paste's clipboard items and read it as a
 * data URL, invoking `onImage` with the result. Returns true if an image was
 * found (and `preventDefault` was called on the event), false otherwise — so
 * callers can let non-image pastes fall through to default text behaviour.
 */
export function handleImagePaste(
  e: { clipboardData: DataTransfer | null; preventDefault: () => void },
  onImage: (dataUrl: string) => void,
): boolean {
  const items = e.clipboardData?.items;
  if (!items) return false;
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return true;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        onImage(dataUrl);
      };
      reader.readAsDataURL(file);
      return true;
    }
  }
  return false;
}

/**
 * Merge a description with any pasted images, appending each image as a markdown
 * reference (`![screenshot-N](dataUrl)`). Mirrors the detail-panel save logic so
 * created and edited issues embed screenshots identically.
 */
export function mergeDescriptionWithImages(description: string, pastedImages: string[]): string {
  const imageMarkdown = pastedImages.map((url, i) => `![screenshot-${i + 1}](${url})`).join("\n");
  return [description.trim(), imageMarkdown].filter(Boolean).join("\n\n");
}

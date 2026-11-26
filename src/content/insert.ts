// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Put text into the editor the person was pasting into, after the AI-chat
 * paste guard held the paste back. Works with plain text fields and with rich
 * editors (contenteditable: ProseMirror, Lexical, Slate, Quill...).
 */

export interface SavedTarget {
  element: Element | null;
  /** Selection inside a text field. */
  start: number | null;
  end: number | null;
  /** Selection inside a contenteditable editor. */
  range: Range | null;
}

type TextField = HTMLTextAreaElement | HTMLInputElement;

const isTextField = (el: Element | null): el is TextField => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;

/** The focused element, looking through open shadow roots. */
export function deepActive(doc: Document): Element | null {
  let el: Element | null = doc.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** Remember where the caret is before a dialog takes the focus away. */
export function saveTarget(doc: Document): SavedTarget {
  const element = deepActive(doc);
  const saved: SavedTarget = { element, start: null, end: null, range: null };
  if (isTextField(element)) {
    try {
      saved.start = element.selectionStart;
      saved.end = element.selectionEnd;
    } catch {
      // input types without a text selection
    }
  } else {
    const sel = doc.getSelection();
    if (sel && sel.rangeCount > 0) saved.range = sel.getRangeAt(0).cloneRange();
  }
  return saved;
}

function restore(doc: Document, saved: SavedTarget): void {
  const el = saved.element;
  if (!(el instanceof HTMLElement) || !el.isConnected) return;
  el.focus({ preventScroll: true });
  if (isTextField(el)) {
    if (saved.start !== null && saved.end !== null) {
      try {
        el.setSelectionRange(saved.start, saved.end);
      } catch {
        // ignore
      }
    }
  } else if (saved.range) {
    const sel = doc.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(saved.range);
    }
  }
}

/**
 * Insert `text` at the saved caret. `markOwn` receives the synthetic paste
 * event we create so our own paste listener can let it through.
 * Returns false when no way of inserting worked.
 */
export function insertText(doc: Document, saved: SavedTarget, text: string, markOwn: (e: Event) => void): boolean {
  restore(doc, saved);
  const el = saved.element;
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;

  if (!isTextField(el)) {
    // Rich editors implement paste themselves: give them a paste event that carries our text.
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true, composed: true });
      markOwn(event);
      if (!el.dispatchEvent(event)) return true; // the editor handled it
    } catch {
      // fall through to the generic ways
    }
  }

  // Keeps undo history and fires the input events frameworks listen for.
  try {
    if (doc.execCommand('insertText', false, text)) return true;
  } catch {
    // fall through
  }

  if (isTextField(el)) {
    try {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.setRangeText(text, start, end, 'end');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
      return true;
    } catch {
      return false;
    }
  }

  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(doc.createTextNode(text));
  range.collapse(false);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
  return true;
}

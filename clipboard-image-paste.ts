import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { matchesKey } from "@earendil-works/pi-tui";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ImageBlock = {
	type: "image";
	data: string;
	mimeType: string;
};

type PendingImage = {
	id: number;
	placeholder: string;
	mediaType: string;
	data: string;
	insertedAt: number;
};

let nextImageId = 1;
let pendingImages: PendingImage[] = [];

type ClipboardPasteContext = {
	cwd: string;
	ui: {
		pasteToEditor(text: string): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		getEditorText(): string;
		setEditorText(text: string): void;
		setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	};
};

async function readWindowsClipboardImage(): Promise<string> {
	const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { Write-Error "Clipboard does not contain an image"; exit 2 }
$stream = New-Object System.IO.MemoryStream
try {
  $img.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($stream.ToArray())
} finally {
  $stream.Dispose()
  $img.Dispose()
}
`;

	const { stdout } = await execFileAsync("powershell.exe", [
		"-NoProfile",
		"-STA",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		script,
	]);
	return stdout.trim();
}

async function readMacClipboardImage(): Promise<string> {
	const jxa = `
ObjC.import('AppKit');
ObjC.import('Foundation');
function base64(data) {
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}
function main() {
  const pb = $.NSPasteboard.generalPasteboard;

  const pngData = pb.dataForType('public.png');
  if (pngData && pngData.length > 0) return base64(pngData);

  const image = $.NSImage.alloc.initWithPasteboard(pb);
  if (!image || !image.isValid) throw new Error('Clipboard does not contain an image');

  const tiffData = image.TIFFRepresentation;
  if (!tiffData) throw new Error('Clipboard image has no TIFF representation');
  const bitmap = $.NSBitmapImageRep.imageRepWithData(tiffData);
  if (!bitmap) throw new Error('Could not create bitmap representation from clipboard image');
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (!png) throw new Error('Could not encode clipboard image as PNG');
  return base64(png);
}
main();
`;

	const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa]);
	return stdout.trim();
}

async function readClipboardImage(): Promise<string> {
	if (process.platform === "win32") {
		return readWindowsClipboardImage();
	}
	if (process.platform === "darwin") {
		return readMacClipboardImage();
	}
	throw new Error("Clipboard image paste is currently implemented for Windows and macOS only.");
}

async function readClipboardText(): Promise<string> {
	if (process.platform === "win32") {
		const { stdout } = await execFileAsync("powershell.exe", [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			"Get-Clipboard -Raw",
		]);
		return stdout;
	}
	if (process.platform === "darwin") {
		const { stdout } = await execFileAsync("pbpaste", []);
		return stdout;
	}
	throw new Error("Clipboard text paste fallback is currently implemented for Windows and macOS only.");
}

function imageBlock(image: PendingImage): ImageBlock {
	return {
		type: "image",
		data: image.data,
		mimeType: image.mediaType,
	};
}

function isCtrlV(data: string): boolean {
	return data === "\x16" || matchesKey(data, "ctrl+v");
}

function isPasteCommandShortcut(data: string): boolean {
	// Some terminals surface menu/clipboard-history paste shortcuts as Alt+V rather
	// than Ctrl+V. The Command key itself is usually handled by the terminal/OS and
	// does not reach the TUI, but this catches terminals that forward the Alt part.
	return matchesKey(data, "alt+v");
}

function getCompleteBracketedPasteContent(data: string): string | undefined {
	const start = data.indexOf("\x1b[200~");
	if (start === -1) return undefined;
	const contentStart = start + "\x1b[200~".length;
	const end = data.indexOf("\x1b[201~", contentStart);
	if (end === -1) return undefined;
	return data.slice(contentStart, end);
}

function isDeleteKey(data: string): boolean {
	return matchesKey(data, "backspace") || matchesKey(data, "delete");
}

function looksLikeUnbracketedMultiLinePaste(data: string): boolean {
	return data.length > 1 && (data.includes("\r") || data.includes("\n"));
}

function normalizeTerminalPasteText(data: string): string {
	return data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function attachedImagesLines(): string[] | undefined {
	if (pendingImages.length === 0) return undefined;
	return ["Attached images:", ...pendingImages.map((image) => `- ${image.placeholder}`)];
}

function updateAttachedImagesWidget(ctx: ClipboardPasteContext): void {
	ctx.ui.setWidget("clipboard-image-paste-attached-images", attachedImagesLines(), { placement: "belowEditor" });
}

function removeTrailingImagePlaceholder(ctx: ClipboardPasteContext): boolean {
	const text = ctx.ui.getEditorText();
	const image = [...pendingImages]
		.sort((a, b) => b.placeholder.length - a.placeholder.length)
		.find((candidate) => text.endsWith(candidate.placeholder) || text.trimEnd().endsWith(candidate.placeholder));
	if (!image) return false;

	const trimmedLength = text.trimEnd().length;
	const trailingWhitespace = text.slice(trimmedLength);
	ctx.ui.setEditorText(text.slice(0, trimmedLength - image.placeholder.length) + trailingWhitespace);
	pendingImages = pendingImages.filter((candidate) => candidate !== image);
	updateAttachedImagesWidget(ctx);
	return true;
}

async function pasteFromClipboard(ctx: ClipboardPasteContext): Promise<void> {
	try {
		const imageId = nextImageId++;
		const data = await readClipboardImage();
		const placeholder = `[Image ${imageId}]`;
		pendingImages.push({
			id: imageId,
			placeholder,
			mediaType: "image/png",
			data,
			insertedAt: Date.now(),
		});

		ctx.ui.pasteToEditor(placeholder);
		updateAttachedImagesWidget(ctx);
		ctx.ui.notify(attachedImagesLines()?.join("\n") ?? "Attached images:", "info");
	} catch (imageError) {
		try {
			const text = await readClipboardText();
			if (text.length > 0) {
				ctx.ui.pasteToEditor(text);
				return;
			}
			ctx.ui.notify(
				`Clipboard does not contain readable image or text. Image error: ${imageError instanceof Error ? imageError.message : String(imageError)}`,
				"warning",
			);
		} catch (textError) {
			ctx.ui.notify(
				`Could not paste from clipboard. Image error: ${imageError instanceof Error ? imageError.message : String(imageError)}. Text error: ${textError instanceof Error ? textError.message : String(textError)}`,
				"error",
			);
		}
	}
}

export default function clipboardImagePaste(pi: ExtensionAPI) {
	let unsubscribeTerminalInput: (() => void) | undefined;
	let activeCtx: ClipboardPasteContext | undefined;

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		unsubscribeTerminalInput?.();
		let bracketedPasteBuffer: string | undefined;
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			// Fully take over Ctrl+V at the raw terminal-input layer, avoiding Pi's built-in
			// paste-image implementation and preserving text paste fallback ourselves.
			if (isCtrlV(data) || isPasteCommandShortcut(data)) {
				void pasteFromClipboard(ctx);
				return { consume: true };
			}

			if (isDeleteKey(data) && removeTrailingImagePlaceholder(ctx)) {
				return { consume: true };
			}

			// Some terminal frontends send paste text as one raw, unbracketed chunk.
			// Route multi-line chunks through Pi's editor paste path so they stay in a
			// single message and still use the compact large-paste display.
			if (looksLikeUnbracketedMultiLinePaste(data)) {
				ctx.ui.pasteToEditor(normalizeTerminalPasteText(data));
				return { consume: true };
			}

			// Terminal/OS paste commands (including clipboard-history pickers such as
			// Cmd+Alt+V on macOS) often arrive as bracketed paste rather than as Ctrl+V.
			// Text pastes include content and should be left alone for Pi's editor. If the
			// bracketed paste is empty, treat it as a possible image-only paste command and
			// read the current OS clipboard image ourselves.
			const completePaste = getCompleteBracketedPasteContent(data);
			if (completePaste !== undefined) {
				if (completePaste.length === 0) {
					void pasteFromClipboard(ctx);
				} else {
					ctx.ui.pasteToEditor(completePaste);
				}
				return { consume: true };
			}

			if (data.includes("\x1b[200~")) {
				bracketedPasteBuffer = data.slice(data.indexOf("\x1b[200~") + "\x1b[200~".length);
				return { consume: true };
			}
			if (bracketedPasteBuffer !== undefined) {
				bracketedPasteBuffer += data;
				const end = bracketedPasteBuffer.indexOf("\x1b[201~");
				if (end !== -1) {
					const pasteContent = bracketedPasteBuffer.slice(0, end);
					bracketedPasteBuffer = undefined;
					if (pasteContent.length === 0) {
						void pasteFromClipboard(ctx);
					} else {
						ctx.ui.pasteToEditor(pasteContent);
					}
				}
				return { consume: true };
			}
			return undefined;
		});
	});

	pi.on("input", async () => {
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		if (pendingImages.length === 0) return;

		const text = event.prompt ?? "";
		const imagesForThisPrompt = pendingImages.filter((image) => text.includes(image.placeholder));

		// If the user deleted an image placeholder, do not attach that image to the prompt.
		pendingImages = pendingImages.filter((image) => !imagesForThisPrompt.includes(image) && text.includes(image.placeholder));
		if (activeCtx) updateAttachedImagesWidget(activeCtx);
		if (imagesForThisPrompt.length === 0) return;

		return {
			message: {
				customType: "clipboard-image-paste",
				display: false,
				content: [
					{
						type: "text" as const,
						text: imagesForThisPrompt.map((image) => `${image.placeholder}: attached clipboard image.`).join("\n"),
					},
					...imagesForThisPrompt.map(imageBlock),
				],
			},
		};
	});

	pi.on("session_shutdown", () => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		activeCtx?.ui.setWidget("clipboard-image-paste-attached-images", undefined, { placement: "belowEditor" });
		activeCtx = undefined;
		pendingImages = [];
	});
}

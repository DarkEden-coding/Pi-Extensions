import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const piExtensionsDir = path.join(os.homedir(), ".pi", "agent", "extensions");

type ImageBlock = {
	type: "image";
	data: string;
	mimeType: string;
};

type PendingImage = {
	id: number;
	placeholder: string;
	path: string;
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

function quotePowerShellSingle(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

async function readWindowsClipboardImage(outputPath: string): Promise<void> {
	const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { Write-Error "Clipboard does not contain an image"; exit 2 }
$path = ${quotePowerShellSingle(outputPath)}
$img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$img.Dispose()
`;

	await execFileAsync("powershell.exe", [
		"-NoProfile",
		"-STA",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		script,
	]);
}

async function readMacClipboardImage(outputPath: string): Promise<void> {
	// Prefer pngpaste when available. It is the most reliable way to read macOS clipboard
	// images, including images selected from clipboard-history tools.
	try {
		await execFileAsync("pngpaste", [outputPath]);
		return;
	} catch {
		// Fall through to the dependency-free AppKit/JXA implementation.
	}

	const jxa = `
ObjC.import('AppKit');
function main() {
  const outputPath = ${JSON.stringify(outputPath)};
  const pb = $.NSPasteboard.generalPasteboard;

  const pngData = pb.dataForType('public.png');
  if (pngData && pngData.length > 0) {
    if (!pngData.writeToFileAtomically($(outputPath), true)) throw new Error('Failed to write PNG clipboard data');
    return 'png-data';
  }

  const image = $.NSImage.alloc.initWithPasteboard(pb);
  if (!image || !image.isValid) throw new Error('Clipboard does not contain an image');

  const tiffData = image.TIFFRepresentation;
  if (!tiffData) throw new Error('Clipboard image has no TIFF representation');
  const bitmap = $.NSBitmapImageRep.imageRepWithData(tiffData);
  if (!bitmap) throw new Error('Could not create bitmap representation from clipboard image');
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (!png) throw new Error('Could not encode clipboard image as PNG');
  if (!png.writeToFileAtomically($(outputPath), true)) throw new Error('Failed to write encoded PNG');
  return 'nsimage';
}
main();
`;

	await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa]);
}

async function readClipboardImage(outputPath: string): Promise<void> {
	if (process.platform === "win32") {
		await readWindowsClipboardImage(outputPath);
		return;
	}
	if (process.platform === "darwin") {
		await readMacClipboardImage(outputPath);
		return;
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
		const dir = path.join(piExtensionsDir, ".pi", "pasted-images");
		await fs.mkdir(dir, { recursive: true });

		const fileName = `image-${new Date().toISOString().replace(/[:.]/g, "-")}-${imageId}.png`;
		const outputPath = path.join(dir, fileName);
		await readClipboardImage(outputPath);

		const data = await fs.readFile(outputPath, "base64");
		const placeholder = `[Image ${imageId}]`;
		pendingImages.push({
			id: imageId,
			placeholder,
			path: outputPath,
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

			// Terminal/OS paste commands (including clipboard-history pickers such as
			// Cmd+Alt+V on macOS) often arrive as bracketed paste rather than as Ctrl+V.
			// Text pastes include content and should be left alone for Pi's editor. If the
			// bracketed paste is empty, treat it as a possible image-only paste command and
			// read the current OS clipboard image ourselves.
			const completePaste = getCompleteBracketedPasteContent(data);
			if (completePaste !== undefined) {
				if (completePaste.length === 0) {
					void pasteFromClipboard(ctx);
					return { consume: true };
				}
				return undefined;
			}

			if (data.includes("\x1b[200~")) {
				bracketedPasteBuffer = data.slice(data.indexOf("\x1b[200~") + "\x1b[200~".length);
				return undefined;
			}
			if (bracketedPasteBuffer !== undefined) {
				bracketedPasteBuffer += data;
				const end = bracketedPasteBuffer.indexOf("\x1b[201~");
				if (end !== -1) {
					const pasteContent = bracketedPasteBuffer.slice(0, end);
					bracketedPasteBuffer = undefined;
					if (pasteContent.length === 0) {
						void pasteFromClipboard(ctx);
						// Do not consume the closing marker here: the editor already saw the
						// opening marker in a previous chunk and needs the close to exit paste mode.
						return undefined;
					}
				}
			}
			return undefined;
		});
	});

	pi.on("input", async (event) => {
		if (pendingImages.length === 0) return { action: "continue" };

		const text = event.text ?? "";
		const imagesForThisPrompt = pendingImages.filter((image) => text.includes(image.placeholder));
		const transformedText = text;

		// If the user deleted an image placeholder, do not attach that image to the prompt.
		pendingImages = pendingImages.filter((image) => !imagesForThisPrompt.includes(image) && text.includes(image.placeholder));
		if (activeCtx) updateAttachedImagesWidget(activeCtx);
		if (imagesForThisPrompt.length === 0) return { action: "continue" };

		const imageList = imagesForThisPrompt
			.map((image, index) => `${index + 1}. ${image.placeholder}: pasted from the OS clipboard and attached as an image object. Saved copy: ${image.path}`)
			.join("\n");

		const instruction = `

System note from clipboard-image-paste extension:
The user pasted ${imagesForThisPrompt.length === 1 ? "this image" : "these images"} into the prompt at the shown inline placeholder${imagesForThisPrompt.length === 1 ? "" : "s"}. Treat each placeholder as referring to the corresponding attached image object:
${imageList}
When answering, use the image content associated with each [Image n] marker. Do not say you cannot see the image unless the active model/provider actually cannot accept image inputs.`;

		return {
			action: "transform",
			text: transformedText + instruction,
			images: [...(event.images ?? []), ...imagesForThisPrompt.map(imageBlock)],
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

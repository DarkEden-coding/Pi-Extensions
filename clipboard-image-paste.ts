import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
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
	path: string;
	mediaType: string;
	data: string;
	insertedAt: number;
};

let nextImageId = 1;
let pendingImages: PendingImage[] = [];

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

function windowsClipboardHasPlainTextOnly(): boolean {
	try {
		execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-STA",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				"Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsText() -and -not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 0 } else { exit 1 }",
			],
			{ stdio: "ignore", timeout: 1000 },
		);
		return true;
	} catch {
		return false;
	}
}

function imageBlock(image: PendingImage): ImageBlock {
	return {
		type: "image",
		data: image.data,
		mimeType: image.mediaType,
	};
}

async function pasteFromClipboard(ctx: { cwd: string; ui: { pasteToEditor(text: string): void; notify(message: string, type?: "info" | "warning" | "error"): void } }): Promise<void> {
	try {
		const imageId = nextImageId++;
		const dir = path.join(ctx.cwd, ".pi", "pasted-images");
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
		ctx.ui.notify(`Inserted ${placeholder} from clipboard image.`, "info");
	} catch (imageError) {
		try {
			const text = await readClipboardText();
			if (text.length > 0) {
				ctx.ui.pasteToEditor(text);
				return;
			}
			ctx.ui.notify("Clipboard does not contain an image or text.", "warning");
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

	pi.on("session_start", (_event, ctx) => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			// Fully take over Ctrl+V at the raw terminal-input layer, avoiding Pi's built-in
			// paste-image implementation and preserving text paste fallback ourselves.
			if (data === "\x16") {
				if (process.platform === "win32" && windowsClipboardHasPlainTextOnly()) {
					return undefined;
				}
				void pasteFromClipboard(ctx);
				return { consume: true };
			}
			return undefined;
		});
	});

	pi.on("input", async (event) => {
		if (pendingImages.length === 0) return { action: "continue" };

		const text = event.text ?? "";
		let imagesForThisPrompt = pendingImages.filter((image) => text.includes(image.placeholder));

		// If the user pasted images but edited away the placeholders, still attach all pending images
		// so Ctrl+V never silently drops an image.
		let transformedText = text;
		if (imagesForThisPrompt.length === 0) {
			imagesForThisPrompt = [...pendingImages];
			const missingPlaceholders = imagesForThisPrompt.map((image) => image.placeholder).join(" ");
			transformedText = transformedText.trim()
				? `${transformedText}\n\n${missingPlaceholders}`
				: missingPlaceholders;
		}

		pendingImages = pendingImages.filter((image) => !imagesForThisPrompt.includes(image));

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
		pendingImages = [];
	});
}

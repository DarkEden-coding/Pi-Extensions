import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
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
	const tmpTiff = outputPath.replace(/\.png$/i, ".tiff");
	const jxa = `
ObjC.import('AppKit');
function main() {
  const pb = $.NSPasteboard.generalPasteboard;
  const png = pb.dataForType('public.png');
  if (png) {
    if (!png.writeToFileAtomically('${outputPath.replace(/'/g, "\\'")}', true)) throw new Error('Failed to write PNG');
    return 'png';
  }
  const tiff = pb.dataForType('public.tiff');
  if (!tiff) throw new Error('Clipboard does not contain an image');
  if (!tiff.writeToFileAtomically('${tmpTiff.replace(/'/g, "\\'")}', true)) throw new Error('Failed to write TIFF');
  return 'tiff';
}
main();
`;

	const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa]);
	if (stdout.trim() === "tiff") {
		await execFileAsync("sips", ["-s", "format", "png", tmpTiff, "--out", outputPath]);
		await fs.rm(tmpTiff, { force: true });
	}
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

export default function clipboardImagePaste(pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+v", {
		description: "Paste from OS clipboard; images become [Image n] attachments",
		handler: async (ctx) => {
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
		},
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
		pendingImages = [];
	});
}

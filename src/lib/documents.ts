export type ImportImage = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp"; label: string };

export async function readDocument(file: File): Promise<{ text: string; images: ImportImage[] }> {
  if (file.size > 10_000_000) throw new Error("Choose a file smaller than 10 MB.");
  if (file.type === "application/pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    task.onPassword = () => { void task.destroy(); };
    const document = await task.promise;
    try {
      if (document.numPages > 10) throw new Error("Choose a PDF with at most 10 pages.");
      const text: string[] = [];
      const images: ImportImage[] = [];
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => "str" in item ? item.str : "").join(" ");
        if (pageText.trim().length > 40) text.push(`Page ${number}: ${pageText}`);
        else {
          const original = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(1.5, 1600 / Math.max(original.width, original.height)) });
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({ canvas, viewport }).promise;
          images.push({ data: canvas.toDataURL("image/jpeg", 0.75).split(",")[1], mediaType: "image/jpeg", label: `Page ${number}` });
          canvas.width = 0;
          canvas.height = 0;
        }
        page.cleanup();
      }
      if (text.join("\n").length > 30_000) throw new Error("The PDF has too much text. Choose the itinerary pages only.");
      return { text: text.join("\n"), images };
    } finally { await task.destroy(); }
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a PDF, JPEG, PNG, or WebP file.");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error("The image dimensions are too large.");
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { text: "", images: [{ data: canvas.toDataURL("image/jpeg", 0.75).split(",")[1], mediaType: "image/jpeg", label: file.name }] };
  } finally { bitmap.close(); }
}
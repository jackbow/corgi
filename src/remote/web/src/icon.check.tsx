import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalSquare } from "lucide-react";
import { colors } from "../../../palette";
import iconSvg from "../public/icon.svg?raw";
import manifestJson from "../public/manifest.webmanifest?raw";

it("uses the header icon and palette for the install icon", () => {
  const xml = new DOMParser(),
    icon = xml.parseFromString(iconSvg, "image/svg+xml"),
    header = xml.parseFromString(renderToStaticMarkup(<TerminalSquare />), "image/svg+xml"),
    group = icon.querySelector("g")!;
  const shapes = (element: Element) =>
    [...element.children].map(el => [
      el.tagName.toLowerCase(),
      ...el
        .getAttributeNames()
        .filter(n => n !== "xmlns")
        .sort()
        .map(n => [n, el.getAttribute(n)]),
    ]);
  expect(shapes(group)).toEqual(shapes(header.documentElement));
  expect(group.getAttribute("stroke")).toBe("#" + colors.accent.map(v => v.toString(16).padStart(2, "0")).join(""));
  const manifest = JSON.parse(manifestJson);
  expect(manifest.icons.find((i: { src: string }) => i.src === "/apple-touch-icon.png").sizes).toBe("180x180");
});

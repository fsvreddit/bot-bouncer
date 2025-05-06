import { markdownToText } from "./controlSubModmail.js";
import json2md from "json2md";

test("Short markdown returns as one chunk", () => {
    const markdown: json2md.DataObject[] = [
        { h1: "Title" },
        { p: "This is a short paragraph." },
    ];

    const result = markdownToText(markdown, 10000);
    expect(result).toHaveLength(1);
});

test("Long markdown returns as more than one chunk", () => {
    const markdown: json2md.DataObject[] = [
        { h1: "Title" },
    ];

    for (let i = 0; i < 50; i++) {
        markdown.push({ p: "This is a short paragraph." });
    }

    const result = markdownToText(markdown, 1000);
    expect(result.length).toBe(2);
});

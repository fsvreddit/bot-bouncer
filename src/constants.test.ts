import { PostFlairTemplate } from "./constants.js";

test("All flair templates match regex", () => {
    const flairTemplateRegex = /^[0-9a-z]{8}(?:-[0-9a-z]{4}){4}[0-9a-z]{8}$/;
    const expected: string[] = [];
    const actual = Object.entries(PostFlairTemplate)
        .map(([key, value]) => ({ key, value }))
        .filter(item => !flairTemplateRegex.test(item.value))
        .map(item => item.key);

    expect(actual).toEqual(expected);
});

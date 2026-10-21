import fsvconfig from "@fsvreddit/eslint-config";

export default [
    ...fsvconfig,
    {
        ignores: ["src/server/core/controlSubCore/similarBioTextFinder/difflib.ts"],
    },
];

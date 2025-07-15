import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import stylistic from '@stylistic/eslint-plugin'
import vitest from "@vitest/eslint-plugin"

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    stylistic.configs.customize({
        indent: 4,
        quotes: "double",
        semi: true,
        quoteProps: "consistent-as-needed",
        braceStyle: "1tbs",
    }),
    {
        files: ["**/*.test.ts"],
        plugins: {
            vitest
        },
        rules: {
            ...vitest.configs.recommended.rules,
            'vitest/valid-title': 'warn',
            'vitest/no-commented-out-tests': 'warn'
        }
    },
    {
        files: ["**/*.ts", "**/*.tsx"],

        languageOptions: {
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
            },
        },

        rules: {
            // Extra rules
            "eqeqeq": ["error", "always", {
                null: "ignore",
            }],
            "no-self-compare": "error",
            "no-template-curly-in-string": "error",
            "no-useless-assignment": "error",
            "no-nested-ternary": "error",
            "no-return-assign": "error",
            "no-sequences": "error",
            "no-var": "error",
            "arrow-body-style": ["error", "as-needed"],
            "func-style": ["error", "declaration", {
                allowArrowFunctions: true,
            }],
            "curly": ["error", "all"],
            "object-shorthand": ["error", "always"],
            "operator-assignment": ["error", "always"],
            "camelcase": ["error", {
                properties: "always",
            }],

            // Rules I don't want
            "@typescript-eslint/restrict-template-expressions": "off",

            // Extra code styling rules
            "@stylistic/array-bracket-newline": ["error", "consistent"],
            "@stylistic/array-element-newline": ["error", "consistent"],
            "@/func-call-spacing": ["error", "never"],
            "@stylistic/function-paren-newline": ["error", "multiline"],
            "@stylistic/implicit-arrow-linebreak": ["error", "beside"],

            "@stylistic/object-curly-newline": ["error", {
                multiline: true,
                consistent: true,
            }],

            "@stylistic/object-property-newline": ["error", {
                allowAllPropertiesOnSameLine: true,
            }],

            "@stylistic/operator-linebreak": ["off"],
            "@stylistic/semi-style": ["error", "last"],
            "@stylistic/space-before-function-paren": ["error", "always"],
        },
    },
    {
        ignores: ["**/node_modules", "**/dist", "eslint.config.mjs", "**/difflib"],
    },
);

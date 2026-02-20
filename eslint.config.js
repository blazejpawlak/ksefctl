const tseslint = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");
const importPlugin = require("eslint-plugin-import");
const nodePlugin = require("eslint-plugin-n");
const globals = require("globals");

const typeCheckedRules =
  tseslint.configs["recommended-type-checked"]?.rules ?? {};
const stylisticRules = tseslint.configs["stylistic-type-checked"]?.rules ?? {};

module.exports = [
  {
    ignores: ["dist/**", "node_modules/**", "src/api/types.ts", "vendor/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: __dirname,
        sourceType: "module",
      },
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      import: importPlugin,
      n: nodePlugin,
    },
    rules: {
      ...typeCheckedRules,
      ...stylisticRules,
      "no-undef": "off",
      "no-console": "off",
      "no-process-exit": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "comma-dangle": ["error", "always-multiline"],
      "import/no-default-export": "error",
      "import/order": [
        "error",
        {
          groups: [
            "type",
            "external",
            "builtin",
            "internal",
            "parent",
            "sibling",
            "index",
            "object",
          ],
          "newlines-between": "never",
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
        },
      ],
      "n/prefer-node-protocol": "error",
      quotes: ["error", "double"],
      semi: ["error", "always"],
    },
  },
];

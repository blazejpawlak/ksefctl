import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { importX } from "eslint-plugin-import-x";
import nodePlugin from "eslint-plugin-n";
import globals from "globals";

const typeCheckedRules =
  tseslint.configs["recommended-type-checked"]?.rules ?? {};
const stylisticRules = tseslint.configs["stylistic-type-checked"]?.rules ?? {};

export default [
  {
    ignores: ["dist/**", "node_modules/**", "src/api/types.ts", "vendor/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
        sourceType: "module",
      },
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "import-x": importX,
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
      "import-x/no-default-export": "error",
      "import-x/order": [
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

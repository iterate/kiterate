// @ts-check
const js = require("@eslint/js");
const typescript = require("@typescript-eslint/eslint-plugin");
const typescriptParser = require("@typescript-eslint/parser");
const jsxA11y = require("eslint-plugin-jsx-a11y");
const importPlugin = require("eslint-plugin-import");
const reactHooks = require("eslint-plugin-react-hooks");
const reactRefresh = require("eslint-plugin-react-refresh");
const { defineConfig, globalIgnores } = require("eslint/config");
const globals = require("globals");

module.exports = defineConfig([
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  globalIgnores([
    "**/.cache/",
    "**/.corepack/",
    "**/.turbo/",
    "**/.cursor/",
    "**/.vscode/",
    "**/components/ui/",
    "**/components/ai-elements/",
    "**/logs.json",
    "**/worker-configuration.d.ts",
    "**/routeTree.gen.ts",
    "**/db/migrations/",
    "**/*.d.ts",
    "**/node_modules/",
    "**/dist/",
    "**/build/",
    "pnpm-lock.yaml",
  ]),
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "@typescript-eslint": typescript,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "jsx-a11y": jsxA11y,
      import: importPlugin,
    },
    rules: {
      "no-unused-vars": "off",
      "no-console": "off",
      "no-empty": "off",
      "no-debugger": "error",
      "prefer-const": "off",
      "no-var": "error",
      "no-redeclare": "off",
      "no-undef": "off",
      "no-param-reassign": "off",

      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-types": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",

      // Disabled - bundlers handle resolution without extensions
      "import/extensions": "off",
      "import/no-unresolved": "off",
      "import/order": "warn",

      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],

      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/no-noninteractive-element-to-interactive-role": "off",
    },
  },
  {
    files: [
      "**/test/**",
      "**/tests/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
    ],
    rules: {
      "no-console": "off",
    },
  },
]);

import js from "@eslint/js";
import globals from "globals";
import security from "eslint-plugin-security";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

const READABILITY_RULES = {
  "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
  "max-depth": ["warn", 4],
  "max-params": ["warn", 5],
  "complexity": ["warn", 15],
  "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "no-shadow": "warn",
  "no-magic-numbers": "off",
  "prefer-const": "warn",
  "eqeqeq": ["error", "smart"],
  "no-var": "error",
};

const ERROR_HANDLING_RULES = {
  "no-throw-literal": "error",
  "prefer-promise-reject-errors": "error",
  "no-empty": ["error", { allowEmptyCatch: false }],
  "no-unused-expressions": "warn",
};

const SECURITY_RULES = {
  ...security.configs.recommended.rules,
  "security/detect-object-injection": "off",
};

const IGNORES = [
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/artifacts/**",
  "**/*.min.js",
  "grid-frontend/next-env.d.ts",
  "grid-frontend/tsconfig.tsbuildinfo",
];

export default [
  { ignores: IGNORES },

  js.configs.recommended,

  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    plugins: { security },
    rules: {
      ...READABILITY_RULES,
      ...ERROR_HANDLING_RULES,
      ...SECURITY_RULES,
    },
  },

  {
    files: [
      "grid-backend/**/*.js",
      "grid-runner-api/**/*.js",
      "grid-runner-workers/**/*.js",
      "grid-selenium-proxy/**/*.js",
      "grid-shared/**/*.js",
      "grid-cli/**/*.js",
      "scripts/**/*.{js,mjs}",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    files: ["**/*.test.js", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "max-lines-per-function": "off",
      "security/detect-non-literal-fs-filename": "off",
    },
  },

  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ["grid-frontend/**/*.{ts,tsx}"],
  })),

  {
    files: ["grid-frontend/**/*.{ts,tsx,js,jsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
      "@next/next": nextPlugin,
      security,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...READABILITY_RULES,
      ...ERROR_HANDLING_RULES,
      ...SECURITY_RULES,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-unused-vars": "off",
    },
  },

  prettier,
];

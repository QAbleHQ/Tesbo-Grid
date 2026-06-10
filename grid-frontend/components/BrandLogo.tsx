"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { THEME_STORAGE_KEY, type ThemeMode, normalizeTheme } from "@/lib/theme";

type BrandLogoProps = {
  variant?: "wordmark" | "mark";
  width?: number;
  height?: number;
  className?: string;
  priority?: boolean;
  alt?: string;
};

function getInitialTheme(): ThemeMode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export default function BrandLogo({
  variant = "wordmark",
  width,
  height,
  className,
  priority,
  alt = "Tesbo Grid",
}: BrandLogoProps) {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

  useEffect(() => {
    setTheme(getInitialTheme());

    const handleStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setTheme(normalizeTheme(e.newValue));
    };

    const observer = new MutationObserver(() => setTheme(getInitialTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    window.addEventListener("storage", handleStorage);
    return () => {
      observer.disconnect();
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  if (variant === "mark") {
    return (
      <Image
        src="/tesbo-grid-mark.svg"
        alt={alt}
        width={width ?? 32}
        height={height ?? 32}
        priority={priority}
        className={className}
      />
    );
  }

  const src =
    theme === "dark"
      ? "/tesbo-grid-logo-dark.svg"
      : "/tesbo-grid-logo-light.svg";

  return (
    <Image
      src={src}
      alt={alt}
      width={width ?? 160}
      height={height ?? 36}
      priority={priority}
      className={className}
    />
  );
}

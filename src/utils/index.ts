export const toBoolean = (value: unknown) => {
  if (typeof value === "boolean") return value;

  if (typeof value === "number") return value === 1;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const truthyValues = new Set(["1", "true", "yes", "y", "on", "success"]);
    return truthyValues.has(normalized);
  }

  return false;
};

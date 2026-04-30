export function maskSecret(input: string): string {
  return input
    .replace(/(password=)([^&\s]+)/gi, "$1****")
    .replace(/(token=)([^&\s]+)/gi, "$1****")
    .replace(/(secret=)([^&\s]+)/gi, "$1****")
    .replace(/:\/\/([^:\s/@]+):([^@\s]+)@/g, "://$1:****@");
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return maskSecret(error.message);
  }
  return maskSecret(String(error));
}

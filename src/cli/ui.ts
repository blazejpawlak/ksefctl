export const printHeader = (title: string): void => {
  console.log(`== ${title} ==`);
};

export const printKeyValues = (
  entries: Array<[string, string | number | null]>,
): void => {
  const maxKey = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  for (const [key, value] of entries) {
    const padded = key.padEnd(maxKey, " ");
    console.log(`${padded} : ${value ?? "-"}`);
  }
};

export const printList = (title: string, items: string[]): void => {
  if (items.length === 0) return;
  console.log(title);
  for (const item of items) {
    console.log(`- ${item}`);
  }
};

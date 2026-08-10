export function paginateItems<T>(items: T[], requestedPage: number, pageSize: number) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(totalPages, Math.max(1, Math.floor(requestedPage)));
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(totalItems, startIndex + pageSize);

  return {
    items: items.slice(startIndex, endIndex),
    page,
    totalPages,
    rangeStart: totalItems === 0 ? 0 : startIndex + 1,
    rangeEnd: endIndex,
    totalItems,
    canPrevious: page > 1,
    canNext: page < totalPages,
  };
}

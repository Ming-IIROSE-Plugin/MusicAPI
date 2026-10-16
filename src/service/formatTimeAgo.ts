export function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();

  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) {
    return `${seconds}秒前`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}分钟前`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    const remainMinutes = minutes % 60;

    if (remainMinutes > 0) {
      return `${hours}小时${remainMinutes}分钟前`;
    }

    return `${hours}小时前`;
  }

  const days = Math.floor(hours / 24);

  if (days < 30) {
    return `${days}天前`;
  }

  const months = Math.floor(days / 30);

  if (months < 12) {
    return `${months}个月前`;
  }

  const years = Math.floor(months / 12);

  return `${years}年前`;
}

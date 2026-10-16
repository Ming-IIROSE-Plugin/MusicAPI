// services/ip.ts

export class IpManager {
  private static currentIp = "49.235.161.77";

  static async fetchRealIp(): Promise<void> {
    try {
      const res = await fetch("https://api.ip.sb/ip");

      if (res.ok) {
        this.currentIp = (await res.text()).trim();

        console.log(`> [System] Public IP: ${this.currentIp}`);
      }
    } catch (err: unknown) {
      console.error(
        "> [Warning] Failed to fetch public IP:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  static getIp(): string {
    return this.currentIp;
  }
}

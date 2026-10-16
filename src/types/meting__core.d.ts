// src/types/meting.d.ts

declare module '@meting/core' {
    // 1. 使用联合类型，这样你在输入 platform 时会有代码提示
    export type MetingServer = 'netease' | 'tencent' | 'kugou' | 'baidu' | 'kuwo';

    export default class Meting
    {
        /**
         * 初始化 Meting 实例
         * @param server 音乐平台代号
         */
        constructor(server: MetingServer | string);

        /**
         * 是否格式化输出
         * 返回 this 以支持链式调用: meting.format(true).cookie(...)
         */
        format(enable: boolean): this;

        /**
         * 设置 Cookie
         * 返回 this 以支持链式调用
         */
        cookie(c: string): this;

        /**
         * 切换平台
         */
        site(server: MetingServer): this;

        /**
         * 获取歌曲直链 URL
         * 注意：返回的是 JSON 字符串，需要 JSON.parse
         * @param id 歌曲 ID
         * @param quality 音质 (如 128, 320 等)
         */
        url(id: string | number, quality?: number): Promise<string>;

        /**
         * 搜索歌曲
         * @param keyword 搜索关键词
         * @param options 分页选项
         */
        search(keyword: string, options?: { page?: number; limit?: number; type?: number }): Promise<string>;
    }
}
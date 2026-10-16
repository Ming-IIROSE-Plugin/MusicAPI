// 统一的目标简化结构
interface MusicAPISimplifiedMusicInfo
{
    songName: string;          // 歌曲名
    translatedName?: string;   // 翻译后的名字
    singerName: string;        // 歌手名称
    pic: string;               // 歌曲封面
    duration: number;          // 歌曲时长（秒）
    audioId: number;           // 歌曲 ID
    hash: string;              // 识别码 (Tencent 平台建议用 mid)
}

// 腾讯 (Tencent) 原始搜索响应接口
interface TencentSearchRawResponse
{
    code: number;
    data: {
        song: {
            list: TencentSongItem[];
            totalnum: number;
        };
    };
}

interface TencentSongItem
{
    id: number;
    mid: string;
    name: string;        // 原始歌名
    title: string;       // 包含翻译的标题
    subtitle: string;    // 副标题/描述
    interval: number;    // 时长 (秒)
    singer: {
        name: string;
    }[];
    album: {
        mid: string;     // 用于拼接封面 URL
        name: string;
    };
}
interface MusicAPISimplifiedMusicInfo
{
    songName: string;          // 歌曲名
    translatedName?: string;   // 翻译后的名字（如果有）
    singerName: string;        // 歌手名称
    pic: string;               // 歌曲封面
    duration: number;          // 歌曲时长（秒）
    audioId: number;           // 歌曲 ID
    hash?: string;              // 酷狗音乐特有的识别码
}

interface MusicAPISearchResult
{
    total: number;                             // 搜索结果总数
    songs: MusicAPISimplifiedMusicInfo[];     // 歌曲列表
}


interface KugouSearchSongResult
{
    relative: Relative;
    black: Black;
    data: SearchData;
    errcode: number;
    status: number;
    error: string;
}

interface Relative
{
    priortype: number;
    singer: Singer[];
}

interface Singer
{
    singername: string;
    albumcount: number;
    correctiontip: string;
    mvcount: number;
    singerid: number;
    songcount: number;
    imgurl: string;
}

interface Black
{
    type: number;
    isblock: number;
}

interface SearchData
{
    timestamp: number;
    tab: string;
    forcecorrection: number;
    correctiontype: number;
    total: number;
    istag: number;
    allowerr: number;
    info: SongInfo[];
    aggregation: unknown[];
    correctiontip: string;
    istagresult: number;
}

interface SongInfo
{
    hash: string;
    sqfilesize: number;
    sourceid: number;
    pay_type_sq: number;
    bitrate: number;
    ownercount: number;
    pkg_price_sq: number;
    songname: string;
    album_name: string;
    songname_original: string;
    Accompany: number;
    sqhash: string;
    fail_process: number;
    pay_type: number;
    rp_type: string;
    album_id: string;
    othername_original: string;
    mvhash: string;
    extname: string;
    group?: SongInfo[];
    price_320: number;
    "320hash": string;
    topic: string;
    othername: string;
    isnew: number;
    fold_type: number;
    old_cpy: number;
    srctype: number;
    singername: string;
    album_audio_id: number;
    duration: number;
    "320filesize": number;
    pkg_price_320: number;
    audio_id: number;
    feetype: number;
    price: number;
    filename: string;
    source: string;
    price_sq: number;
    fail_process_320: number;
    trans_param: TransParam;
    pkg_price: number;
    pay_type_320: number;
    topic_url: string;
    m4afilesize: number;
    rp_publish: number;
    privilege: number;
    filesize: number;
    isoriginal: number;
    "320privilege": number;
    sqprivilege: number;
    fail_process_sq: number;
}

interface TransParam
{
    cpy_grade?: number;
    classmap: {
        attr0: number;
    };
    language: string;
    cpy_attr0: number;
    musicpack_advance: number;
    ogg_128_filesize: number;
    display_rate: number;
    ogg_320_filesize: number;
    qualitymap: {
        bits: string;
        attr0: number;
        attr1: number;
    };
    union_cover: string;
    ogg_128_hash: string;
    cid: number;
    ogg_320_hash: string;
    display: number;
    ipmap: {
        attr0: number;
    };
    hash_offset?: {
        clip_hash: string;
        start_byte: number;
        end_ms: number;
        end_byte: number;
        file_type: number;
        start_ms: number;
        offset_hash: string;
    };
    hash_multitrack: string;
    pay_block_tpl: number;
    cpy_level: number;
    all_quality_free?: number;
    appid_block?: string;
    songname_suffix?: string;
}
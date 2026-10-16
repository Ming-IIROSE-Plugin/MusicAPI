import * as crypto from 'crypto';

export class NeteaseCrypto
{
    private static readonly iv = Buffer.from('0102030405060708');
    private static readonly presetKey = Buffer.from('0CoJUm6Qyw8W8jud');
    private static readonly linuxapiKey = Buffer.from('rFgB&h#%2?^eDg:Q');
    private static readonly base62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    private static readonly publicKey = `
-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----
`;


    // 网易云音乐 eapi 固定的 key
    private static readonly eapiKey = 'e82ckenh8dichen8';

    public static eapi = (url: string, object: object) =>
    {
        const text = typeof object === 'object' ? JSON.stringify(object) : object;
        const message = `nobody${url}use${text}md5forencrypt`;
        const digest = crypto.createHash('md5').update(message).digest('hex');
        const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;

        return {
            params: this.aesEncrypt(Buffer.from(data), 'ecb', this.eapiKey, '')
                .toString('hex')
                .toUpperCase(),
        };
    };

    public static weapi = (object: object | { csrf_token: string }) =>
    {
        const text = JSON.stringify(object);
        const secretKey = crypto.randomBytes(16).map((n) => this.base62.charAt(n % 62).charCodeAt(0));
        return {
            params: this.aesEncrypt(
                Buffer.from(
                    this.aesEncrypt(Buffer.from(text), 'cbc', this.presetKey, this.iv).toString('base64'),
                ),
                'cbc',
                secretKey,
                this.iv,
            ).toString('base64'),
            encSecKey: this.rsaEncrypt(Buffer.from(secretKey.reverse()), this.publicKey).toString('hex'),
        };
    };

    private static linuxapi = (object: object): LinuxapiResult =>
    {
        const text = JSON.stringify(object);
        return {
            eparams: this.aesEncrypt(Buffer.from(text), 'ecb', this.linuxapiKey, '')
                .toString('hex')
                .toUpperCase(),
        };
    };


    private static aesEncrypt = (buffer: Buffer, mode: string, key: Uint8Array | string, iv: Buffer | string): Buffer =>
    {
        const cipher = crypto.createCipheriv('aes-128-' + mode, key, iv);
        return Buffer.concat([cipher.update(buffer), cipher.final()]);
    };

    private static rsaEncrypt = (buffer: Buffer, key: string): Buffer =>
    {
        buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
        return crypto.publicEncrypt({ key: key, padding: crypto.constants.RSA_NO_PADDING }, buffer);
    };

    private static decrypt = (cipherBuffer: Buffer): Buffer =>
    {
        const decipher = crypto.createDecipheriv('aes-128-ecb', this.eapiKey, '');
        return Buffer.concat([decipher.update(cipherBuffer), decipher.final()]);
    };
}
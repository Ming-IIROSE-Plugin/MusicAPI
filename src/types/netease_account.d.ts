interface NeteaseAccountInfo {
  code: number;
  account: null | NeteaseAccount;
  profile: null | NeteaseProfile;
}

interface NeteaseAccount {
  id: number;
  userName: string;
  type: number;
  status: number;
  whitelistAuthority: number;
  createTime: number;
  tokenVersion: number;
  ban: number;
  baoyueVersion: number;
  donateVersion: number;
  vipType: number;
  anonimousUser: boolean;
  paidFee: boolean;
}

interface NeteaseProfile {
  userId: number;
  userType: number;
  nickname: string;
  avatarImgId: number;
  avatarUrl: string;
  backgroundImgId: number;
  backgroundUrl: string;
  signature: string;
  createTime: number;
  userName: string;
  accountType: number;
  shortUserName: string;
  birthday: number;
  authority: number;
  gender: number;
  accountStatus: number;
  province: number;
  city: number;
  authStatus: number;
  description: null | string;
  detailDescription: null | string;
  defaultAvatar: boolean;
  expertTags: null | string[];
  experts: null | Record<string, unknown>;
  djStatus: number;
  locationStatus: number;
  vipType: number;
  viptypeVersion: number;
  authenticationTypes: number;
  avatarDetail: null | Record<string, unknown>;
  anchor: boolean;
  followed: boolean;
  mutual: boolean;
  authenticated: boolean;
  lastLoginTime: number;
  lastLoginIP: string;
  remarkName: null | string;
}

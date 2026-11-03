// Group names that ship with every install. They are only a starting point:
// the panel lets the user rename, merge and delete them freely, and an empty
// list is never re-seeded once the user has had one.
export const DEFAULT_GROUP_NAMES = [
    "崩坏：星穹铁道",
    "崩坏3",
    "原神",
    "鸣潮",
    "绝区零",
    "明日方舟：终末地",
    "BanG Dream!",
    "GIRLS BAND CRY",
    "孤独摇滚",
    "我的青春恋爱物语果然有问题",
    "千恋＊万花",
    "关于邻家的天使大人",
    "不时轻声地以俄语遮羞的邻座艾莉同学",
    "五等分的新娘",
    "偶像大师·闪耀色彩",
];

// Which shipped voice belongs to which work, keyed by the Fish voice id.
// Only ids still on their group-less or default state are re-filed at startup,
// so a user who drags a voice elsewhere keeps that choice across upgrades.
export const DEFAULT_VOICE_GROUPS = [
    {
        group: "崩坏：星穹铁道",
        ids: [
            "f83297334ee44cdba67d1c49827fd9db", "93876490c0864faf8535e6dc8d4ab55b", "f9ede0382ffc4671ac86b44d49f19cdd", "901be428c02c44a6b42127df1385658e",
            "050fae87b2f34537925523de8bff1a76", "2c4573648d884691bc90544e6d2e32a4", "4baa4ffa7f4d4cf4aae644409ae0ee73",
        ],
    },
    {
        group: "崩坏3",
        ids: [
            "2b87b364fbfe49a29fe77e5a68282c7e", "102bbcad98b0447a8c7047d2c0fee9ab", "f06ed9ea97004b45ae790daf61a7f4c0",
        ],
    },
    {
        group: "原神",
        ids: [
            "82be345a2acb450dbdc07ab31447ca6b",
        ],
    },
    {
        group: "鸣潮",
        ids: [
            "f394e8ff088f4713922231f327744483", "1fa6a46da8484d72a4c4809dbb944943", "6efa488f935f4212bdb95398615a0c00", "36cdbafcc03c4c3882d05b372c90259d",
            "1e7af7fae6504e1984e18d5c428591dc", "f0574ad04e634b929597283aaf6b6c1c", "c6f1a42ab4b4410ab95fe4b5522ecc5e", "30ad478e008b4142babab2675dac1834",
            "da6a6205c31d451fabb28c3d139adfa8", "caa0d59b603249b883f12d0a77cce1ad",
        ],
    },
    {
        group: "绝区零",
        ids: [
            "fd0b32e877384978a0eba25bd498a739", "0bbbeb0ebfa249aaa76af7c407052a6e",
        ],
    },
    {
        group: "明日方舟：终末地",
        ids: [
            "cd9778891fd541e98331a8a0dde60fd1",
        ],
    },
    {
        group: "BanG Dream!",
        ids: [
            "f748127d4f304f0a903cffb3d2fa2a7b",
        ],
    },
    {
        group: "GIRLS BAND CRY",
        ids: [
            "f65d41b9808c45f0916f8c9ea3810f28",
        ],
    },
    {
        group: "孤独摇滚",
        ids: [
            "5f2c07ad18624123b1402228617c80ca", "ccdb58867c584a329a38a7bf44243b73", "93ce6c71c6194044b98d3cc72340d0bb",
        ],
    },
    {
        group: "我的青春恋爱物语果然有问题",
        ids: [
            "0d63094cad60462893558e2ed95ff47f",
        ],
    },
    {
        group: "千恋＊万花",
        ids: [
            "8447c04b00dd470a96c0d6575e612dd1",
        ],
    },
    {
        group: "关于邻家的天使大人",
        ids: [
            "eeed5257e3804629968195e044f1a091",
        ],
    },
    {
        group: "不时轻声地以俄语遮羞的邻座艾莉同学",
        ids: [
            "15b8bae03d344eafaa53f174fb13cf32",
        ],
    },
    {
        group: "五等分的新娘",
        ids: [
            "2a5aa2ddc1884afe8469cded946613ef",
        ],
    },
    {
        group: "偶像大师·闪耀色彩",
        ids: [
            "a1150f3d14ac46fb8ea59c7803cd8357", "df43849d16ae48fe87f5670b6a2b81b3", "17ce7b6d4ccb43a2bedac1fdb4a219cb", "a11bfd046e924099a84f989fb4049e95",
            "1cbb1ba24d094810a6cada880dd8dec0", "3543f8d3e498439794f14be23dafbe89", "e6b09fdf01874e63adf5f8aa45c0d2ea", "115e921e1b4740b08f3ec723666b2b40",
            "db8fb218614745f6b854e24620c33445", "9fa98a656a0d4242b6073fd955f5179b", "8ee2e17bbead4610a17f324fe540be49", "565ffd381fbc427ebfa1cc4c689ac12d",
            "b3757a5a71ba4078be1e25b446190975", "bf578eec18ca49daaf9216f5df3fabd4", "2dcc8351008f4714b33506d7d45a861e", "105efba2160a40119d6d21e5445b889e",
            "1f0033aac5b34d478ec975114c845bf9", "d9e61a6914dd47669a9bbae71a78ab38", "a48ea1f5d81a478ba528b49188bf4ccc", "8875da3542374b18a29b85fbf48f0de2",
            "dd73b57d509b436b90ef9263d2e6c5d1", "70e8160d2cf34c5892b9002e42cbafdb", "d5a68fc022604b23b94e2a0b9f823b59", "7f50c8ef897c402fa7967a11aa94261e",
            "7de8d70dc5e04759be11c01f69c8c863", "79e3dd87aa7649dab07350896ce995ae", "ccfce7160c664853813988cea175d1ab", "5dd68541a9a04f50b9332572e0d266ff",
        ],
    },
];

export function defaultGroupFor(voiceId) {
    for (const item of DEFAULT_VOICE_GROUPS) {
        if (item.ids.includes(voiceId)) return item.group;
    }
    return '';
}

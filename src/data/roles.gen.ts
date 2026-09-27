// 本文件由脚本生成，请勿手动修改。
// 来源：nethack/src/role.c
// 重新生成：bun tools/extract-nh-roles.ts [NetHack 源码路径]
// 内容派生自 NetHack，按 NetHack General Public License 分发，见 NOTICE.md。

import type { RoleData } from '../types';

export const ROLES: RoleData[] = [
  {
    "id": "ARCHEOLOGIST",
    "names": {
      "male": "Archeologist",
      "female": "0"
    },
    "attrs": {
      "str": 7,
      "int": 10,
      "wis": 10,
      "dex": 7,
      "con": 7,
      "cha": 7
    },
    "attrdist": {
      "str": 20,
      "int": 20,
      "wis": 20,
      "dex": 10,
      "con": 20,
      "cha": 10
    },
    "hp": {
      "infix": 11,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 1,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 1
    },
    "xlev": 14,
    "initRecord": 10,
    "spell": {
      "base": 5,
      "heal": 0,
      "shield": 2,
      "armor": 10,
      "stat": "int",
      "spec": "SPE_MAGIC_MAPPING",
      "bonus": -4
    },
    "allowMask": 12398,
    "aligns": [
      "lawful",
      "neutral"
    ],
    "races": [
      "HUMAN",
      "DWARF",
      "GNOME"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "BARBARIAN",
    "names": {
      "male": "Barbarian",
      "female": "0"
    },
    "attrs": {
      "str": 16,
      "int": 7,
      "wis": 7,
      "dex": 15,
      "con": 16,
      "cha": 6
    },
    "attrdist": {
      "str": 30,
      "int": 6,
      "wis": 7,
      "dex": 20,
      "con": 30,
      "cha": 7
    },
    "hp": {
      "infix": 14,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 10,
      "hifix": 2,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 1
    },
    "xlev": 10,
    "initRecord": 10,
    "spell": {
      "base": 14,
      "heal": 0,
      "shield": 0,
      "armor": 8,
      "stat": "int",
      "spec": "SPE_HASTE_SELF",
      "bonus": -4
    },
    "allowMask": 12427,
    "aligns": [
      "neutral",
      "chaotic"
    ],
    "races": [
      "HUMAN",
      "ORC"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "CAVE_DWELLER",
    "names": {
      "male": "Caveman",
      "female": "Cavewoman"
    },
    "attrs": {
      "str": 10,
      "int": 7,
      "wis": 7,
      "dex": 7,
      "con": 8,
      "cha": 6
    },
    "attrdist": {
      "str": 30,
      "int": 6,
      "wis": 7,
      "dex": 20,
      "con": 30,
      "cha": 7
    },
    "hp": {
      "infix": 14,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 2,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 1
    },
    "xlev": 10,
    "initRecord": 0,
    "spell": {
      "base": 12,
      "heal": 0,
      "shield": 1,
      "armor": 8,
      "stat": "int",
      "spec": "SPE_DIG",
      "bonus": -4
    },
    "allowMask": 12398,
    "aligns": [
      "lawful",
      "neutral"
    ],
    "races": [
      "HUMAN",
      "DWARF",
      "GNOME"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "HEALER",
    "names": {
      "male": "Healer",
      "female": "0"
    },
    "attrs": {
      "str": 7,
      "int": 7,
      "wis": 13,
      "dex": 7,
      "con": 11,
      "cha": 16
    },
    "attrdist": {
      "str": 15,
      "int": 20,
      "wis": 20,
      "dex": 15,
      "con": 25,
      "cha": 5
    },
    "hp": {
      "infix": 11,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 1,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 4,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 2
    },
    "xlev": 20,
    "initRecord": 10,
    "spell": {
      "base": 3,
      "heal": -3,
      "shield": 2,
      "armor": 10,
      "stat": "wis",
      "spec": "SPE_CURE_SICKNESS",
      "bonus": -4
    },
    "allowMask": 12362,
    "aligns": [
      "neutral"
    ],
    "races": [
      "HUMAN",
      "GNOME"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "KNIGHT",
    "names": {
      "male": "Knight",
      "female": "0"
    },
    "attrs": {
      "str": 13,
      "int": 7,
      "wis": 14,
      "dex": 8,
      "con": 10,
      "cha": 17
    },
    "attrdist": {
      "str": 30,
      "int": 15,
      "wis": 15,
      "dex": 10,
      "con": 20,
      "cha": 10
    },
    "hp": {
      "infix": 14,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 2,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 4,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 2
    },
    "xlev": 10,
    "initRecord": 10,
    "spell": {
      "base": 8,
      "heal": -2,
      "shield": 0,
      "armor": 9,
      "stat": "wis",
      "spec": "SPE_TURN_UNDEAD",
      "bonus": -4
    },
    "allowMask": 12300,
    "aligns": [
      "lawful"
    ],
    "races": [
      "HUMAN"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "MONK",
    "names": {
      "male": "Monk",
      "female": "0"
    },
    "attrs": {
      "str": 10,
      "int": 7,
      "wis": 8,
      "dex": 8,
      "con": 7,
      "cha": 7
    },
    "attrdist": {
      "str": 25,
      "int": 10,
      "wis": 20,
      "dex": 20,
      "con": 15,
      "cha": 10
    },
    "hp": {
      "infix": 12,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 1,
      "hirnd": 0
    },
    "energy": {
      "infix": 2,
      "inrnd": 2,
      "lofix": 0,
      "lornd": 2,
      "hifix": 0,
      "hirnd": 2
    },
    "xlev": 10,
    "initRecord": 10,
    "spell": {
      "base": 8,
      "heal": -2,
      "shield": 2,
      "armor": 20,
      "stat": "wis",
      "spec": "SPE_RESTORE_ABILITY",
      "bonus": -4
    },
    "allowMask": 12303,
    "aligns": [
      "lawful",
      "neutral",
      "chaotic"
    ],
    "races": [
      "HUMAN"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "CLERIC",
    "names": {
      "male": "Priest",
      "female": "Priestess"
    },
    "attrs": {
      "str": 7,
      "int": 7,
      "wis": 10,
      "dex": 7,
      "con": 7,
      "cha": 7
    },
    "attrdist": {
      "str": 15,
      "int": 10,
      "wis": 30,
      "dex": 15,
      "con": 20,
      "cha": 10
    },
    "hp": {
      "infix": 12,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 1,
      "hirnd": 0
    },
    "energy": {
      "infix": 4,
      "inrnd": 3,
      "lofix": 0,
      "lornd": 2,
      "hifix": 0,
      "hirnd": 2
    },
    "xlev": 10,
    "initRecord": 0,
    "spell": {
      "base": 3,
      "heal": -2,
      "shield": 2,
      "armor": 10,
      "stat": "wis",
      "spec": "SPE_REMOVE_CURSE",
      "bonus": -4
    },
    "allowMask": 12319,
    "aligns": [
      "lawful",
      "neutral",
      "chaotic"
    ],
    "races": [
      "HUMAN",
      "ELF"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "ROGUE",
    "names": {
      "male": "Rogue",
      "female": "0"
    },
    "attrs": {
      "str": 7,
      "int": 7,
      "wis": 7,
      "dex": 10,
      "con": 7,
      "cha": 6
    },
    "attrdist": {
      "str": 20,
      "int": 10,
      "wis": 10,
      "dex": 30,
      "con": 20,
      "cha": 10
    },
    "hp": {
      "infix": 10,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 1,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 1
    },
    "xlev": 11,
    "initRecord": 10,
    "spell": {
      "base": 8,
      "heal": 0,
      "shield": 1,
      "armor": 9,
      "stat": "int",
      "spec": "SPE_DETECT_TREASURE",
      "bonus": -4
    },
    "allowMask": 12425,
    "aligns": [
      "chaotic"
    ],
    "races": [
      "HUMAN",
      "ORC"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "RANGER",
    "names": {
      "male": "Ranger",
      "female": "0"
    },
    "attrs": {
      "str": 13,
      "int": 13,
      "wis": 13,
      "dex": 9,
      "con": 13,
      "cha": 7
    },
    "attrdist": {
      "str": 30,
      "int": 10,
      "wis": 10,
      "dex": 20,
      "con": 20,
      "cha": 10
    },
    "hp": {
      "infix": 13,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 6,
      "hifix": 1,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 1
    },
    "xlev": 12,
    "initRecord": 10,
    "spell": {
      "base": 9,
      "heal": 2,
      "shield": 1,
      "armor": 10,
      "stat": "int",
      "spec": "SPE_INVISIBILITY",
      "bonus": -4
    },
    "allowMask": 12507,
    "aligns": [
      "neutral",
      "chaotic"
    ],
    "races": [
      "HUMAN",
      "ELF",
      "GNOME",
      "ORC"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "SAMURAI",
    "names": {
      "male": "Samurai",
      "female": "0"
    },
    "attrs": {
      "str": 10,
      "int": 8,
      "wis": 7,
      "dex": 10,
      "con": 17,
      "cha": 6
    },
    "attrdist": {
      "str": 30,
      "int": 10,
      "wis": 8,
      "dex": 30,
      "con": 14,
      "cha": 8
    },
    "hp": {
      "infix": 13,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 1,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 1
    },
    "xlev": 11,
    "initRecord": 10,
    "spell": {
      "base": 10,
      "heal": 0,
      "shield": 0,
      "armor": 8,
      "stat": "int",
      "spec": "SPE_CLAIRVOYANCE",
      "bonus": -4
    },
    "allowMask": 12300,
    "aligns": [
      "lawful"
    ],
    "races": [
      "HUMAN"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "TOURIST",
    "names": {
      "male": "Tourist",
      "female": "0"
    },
    "attrs": {
      "str": 7,
      "int": 10,
      "wis": 6,
      "dex": 7,
      "con": 7,
      "cha": 10
    },
    "attrdist": {
      "str": 15,
      "int": 10,
      "wis": 10,
      "dex": 15,
      "con": 30,
      "cha": 20
    },
    "hp": {
      "infix": 8,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 0,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 1
    },
    "xlev": 14,
    "initRecord": 0,
    "spell": {
      "base": 5,
      "heal": 1,
      "shield": 2,
      "armor": 10,
      "stat": "int",
      "spec": "SPE_CHARM_MONSTER",
      "bonus": -4
    },
    "allowMask": 12298,
    "aligns": [
      "neutral"
    ],
    "races": [
      "HUMAN"
    ],
    "genders": [
      "male",
      "female"
    ]
  },
  {
    "id": "VALKYRIE",
    "names": {
      "male": "Valkyrie",
      "female": "0"
    },
    "attrs": {
      "str": 10,
      "int": 7,
      "wis": 7,
      "dex": 7,
      "con": 10,
      "cha": 7
    },
    "attrdist": {
      "str": 30,
      "int": 6,
      "wis": 7,
      "dex": 20,
      "con": 30,
      "cha": 7
    },
    "hp": {
      "infix": 14,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 2,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 1
    },
    "xlev": 10,
    "initRecord": 0,
    "spell": {
      "base": 10,
      "heal": -2,
      "shield": 0,
      "armor": 9,
      "stat": "wis",
      "spec": "SPE_CONE_OF_COLD",
      "bonus": -4
    },
    "allowMask": 8238,
    "aligns": [
      "lawful",
      "neutral"
    ],
    "races": [
      "HUMAN",
      "DWARF"
    ],
    "genders": [
      "female"
    ]
  },
  {
    "id": "WIZARD",
    "names": {
      "male": "Wizard",
      "female": "0"
    },
    "attrs": {
      "str": 7,
      "int": 10,
      "wis": 7,
      "dex": 7,
      "con": 7,
      "cha": 7
    },
    "attrdist": {
      "str": 10,
      "int": 30,
      "wis": 10,
      "dex": 20,
      "con": 20,
      "cha": 10
    },
    "hp": {
      "infix": 10,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 8,
      "hifix": 1,
      "hirnd": 0
    },
    "energy": {
      "infix": 4,
      "inrnd": 3,
      "lofix": 0,
      "lornd": 2,
      "hifix": 0,
      "hirnd": 3
    },
    "xlev": 12,
    "initRecord": 0,
    "spell": {
      "base": 1,
      "heal": 0,
      "shield": 3,
      "armor": 10,
      "stat": "int",
      "spec": "SPE_MAGIC_MISSILE",
      "bonus": -4
    },
    "allowMask": 12507,
    "aligns": [
      "neutral",
      "chaotic"
    ],
    "races": [
      "HUMAN",
      "ELF",
      "GNOME",
      "ORC"
    ],
    "genders": [
      "male",
      "female"
    ]
  }
];

// 本文件由脚本生成，请勿手动修改。
// 来源：nethack/src/role.c
// 重新生成：bun tools/extract-nh-roles.ts [NetHack 源码路径]
// 内容派生自 NetHack，按 NetHack General Public License 分发，见 NOTICE.md。

import type { RaceData } from '../types';

export const RACES: RaceData[] = [
  {
    "id": "HUMAN",
    "name": "human",
    "adj": "human",
    "filecode": "Hum",
    "names": {
      "male": "man",
      "female": "woman"
    },
    "attrs": {
      "str": 3,
      "int": 3,
      "wis": 3,
      "dex": 3,
      "con": 3,
      "cha": 3
    },
    "attrmax": {
      "str": 18,
      "int": 18,
      "wis": 18,
      "dex": 18,
      "con": 18,
      "cha": 18
    },
    "hp": {
      "infix": 2,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 2,
      "hifix": 1,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 2,
      "lornd": 0,
      "hifix": 2,
      "hirnd": 0
    },
    "allowMask": 12303,
    "aligns": [
      "lawful",
      "neutral",
      "chaotic"
    ]
  },
  {
    "id": "ELF",
    "name": "elf",
    "adj": "elven",
    "filecode": "Elf",
    "names": {
      "male": "0",
      "female": "0"
    },
    "attrs": {
      "str": 3,
      "int": 3,
      "wis": 3,
      "dex": 3,
      "con": 3,
      "cha": 3
    },
    "attrmax": {
      "str": 18,
      "int": 20,
      "wis": 20,
      "dex": 18,
      "con": 16,
      "cha": 18
    },
    "hp": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 1,
      "hirnd": 0
    },
    "energy": {
      "infix": 2,
      "inrnd": 0,
      "lofix": 3,
      "lornd": 0,
      "hifix": 3,
      "hirnd": 0
    },
    "allowMask": 12305,
    "aligns": [
      "chaotic"
    ]
  },
  {
    "id": "DWARF",
    "name": "dwarf",
    "adj": "dwarven",
    "filecode": "Dwa",
    "names": {
      "male": "0",
      "female": "0"
    },
    "attrs": {
      "str": 3,
      "int": 3,
      "wis": 3,
      "dex": 3,
      "con": 3,
      "cha": 3
    },
    "attrmax": {
      "str": 18,
      "int": 16,
      "wis": 16,
      "dex": 20,
      "con": 20,
      "cha": 16
    },
    "hp": {
      "infix": 4,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 3,
      "hifix": 2,
      "hirnd": 0
    },
    "energy": {
      "infix": 0,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 0,
      "hifix": 0,
      "hirnd": 0
    },
    "allowMask": 12324,
    "aligns": [
      "lawful"
    ]
  },
  {
    "id": "GNOME",
    "name": "gnome",
    "adj": "gnomish",
    "filecode": "Gno",
    "names": {
      "male": "0",
      "female": "0"
    },
    "attrs": {
      "str": 3,
      "int": 3,
      "wis": 3,
      "dex": 3,
      "con": 3,
      "cha": 3
    },
    "attrmax": {
      "str": 18,
      "int": 19,
      "wis": 18,
      "dex": 18,
      "con": 18,
      "cha": 18
    },
    "hp": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 0
    },
    "energy": {
      "infix": 2,
      "inrnd": 0,
      "lofix": 2,
      "lornd": 0,
      "hifix": 2,
      "hirnd": 0
    },
    "allowMask": 12354,
    "aligns": [
      "neutral"
    ]
  },
  {
    "id": "ORC",
    "name": "orc",
    "adj": "orcish",
    "filecode": "Orc",
    "names": {
      "male": "0",
      "female": "0"
    },
    "attrs": {
      "str": 3,
      "int": 3,
      "wis": 3,
      "dex": 3,
      "con": 3,
      "cha": 3
    },
    "attrmax": {
      "str": 18,
      "int": 16,
      "wis": 16,
      "dex": 18,
      "con": 18,
      "cha": 16
    },
    "hp": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 0,
      "lornd": 1,
      "hifix": 0,
      "hirnd": 0
    },
    "energy": {
      "infix": 1,
      "inrnd": 0,
      "lofix": 1,
      "lornd": 0,
      "hifix": 1,
      "hirnd": 0
    },
    "allowMask": 12417,
    "aligns": [
      "chaotic"
    ]
  }
];

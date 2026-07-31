# Проверка кандидатов на добавление в master_items (сверх текущих 2328)

## Контекст

В ходе ресерча по бартеру у NPC «Арсен» обнаружилось, что `master_items` (синк из
`EXBO-Studio/stalzone-database`, `ru/listing.json`) отстаёт от реального набора предметов в игре.
Собраны кандидаты из нескольких внешних источников (Lunar `lunar-zone.ru`, `stalzone.wiki`,
`stalzone-monitor.ru`, EXBO `global/listing.json`) — итого 366 id, которых нет в текущей БД.
Каждый прогнан через реальный `stalcraft_client.get_auction_lots` + `get_auction_history` (регион RU).

Отдельно осталось 15 предметов, для которых **id не нашёлся вообще ни в одном источнике**
(включая проверку официального EXBO-репозитория, обеих его веток `ru`/`global`, и обеих
публичных вики) — по ним проверить через API нечего.

---

## 1) Найдено и подтверждено — 251 id

Реально торгуются (лоты и/или история продаж > 0). Формат: `id | название | категория | lots | history`.

```
lypmj  Рюкзак                                    other                 lots=2698 hist=6409297
dm6l2  Протоартефакт                             other                 lots=1773 hist=13518981
3gq6k  Набор компонентов оружия (Мастер)          other                 lots=351  hist=3810062
y4g93  Фильтр                                     other                 lots=306  hist=1548796
wj3jz  Новогодний кейс 7-го уровня                other                 lots=302  hist=1642718
g41qg  Ящик патронов 9x39 СБП                     other                 lots=288  hist=755809
6w9k6  Ящик патронов 5.45 мм СПБ                  other                 lots=258  hist=595992
zzwl2  Инъектор                                   other                 lots=242  hist=1068780
y3430  Новогодний кейс 6-го уровня                other                 lots=232  hist=99354
1rlzq  Ящик патронов 7.62 мм СБП                  other                 lots=219  hist=860700
z3o52  Боевой набор                               other                 lots=216  hist=3609483
drpw5  Старый скарб                               other                 lots=197  hist=2088421
96zlw  Ящик патронов 5.56 мм СБП                  other                 lots=153  hist=689684
9d1p0  Черный презент                             other                 lots=128  hist=2934726
lyrzj  Хроноустановка                             other                 lots=120  hist=226216
y4gr3  Крупный артефактный фрагмент               other                 lots=116  hist=138656
3gqyk  Ящик патронов 9 мм СПБ                     other                 lots=98   hist=624246
ly90o  Кейс с обликами «Славянской весны»         other                 lots=94   hist=1095840
m0q1k  Хвост шавки                                other                 lots=84   hist=202749
p6qm5  Компонент брони (Мастер)                   other                 lots=84   hist=120089
z3wgm  Запчасти для ПДА                           other                 lots=83   hist=343596
krpnp  Лоскут светящейся кожи                     other                 lots=81   hist=320991
2o0qm  Набор компонентов оружия (Ветеран)          other                 lots=78   hist=698146
p6q5d  Копыто кабана                              other                 lots=75   hist=109305
5l5lo  Новогодний кейс 5-го уровня                other                 lots=73   hist=55145
0rl4r  Компонент оружия (Мастер)                  other                 lots=65   hist=458621
007oy  Кость мутанта                              other                 lots=64   hist=132975
21rp5  Предохранитель                             other                 lots=62   hist=96699
lyr7q  Компонент оружия (Сталкер)                 other                 lots=61   hist=163630
dmyg9  Набор компонентов оружия (Сталкер)          other                 lots=60   hist=183631
wjlzz  Рука сильного шныря                        other                 lots=58   hist=96952
4q75j  Хвост слабой дикой гончей                  other                 lots=54   hist=35161
w3zpp  Благодать Перуна                           other                 lots=54   hist=2027073
okp04  Компонент брони (Сталкер)                  other                 lots=53   hist=51176
vj31g  Набор компонентов оружия(Новичек)           other                 lots=50   hist=81557
771lj  Ноутбук                                    other                 lots=49   hist=105428
5539g  Оружейный кейс                             other                 lots=46   hist=19273
g41o0  Аномальная установка                       other                 lots=46   hist=284032
n4wg9  Глаз хрюши                                 other                 lots=46   hist=303671
96znw  Набор компонентов брони (Ветеран)           other                 lots=44   hist=295854
oklqm  Болт                                       other                 lots=44   hist=72368
g4n4n  Новогодний кейс 3-го уровня                other                 lots=42   hist=42187
7l65j  Самодельная скошенная рукоятка             other                 lots=41   hist=57101
19o22  Сигареты                                   other                 lots=39   hist=62316
j5q74  Компонент оружия (Новичек)                 other                 lots=39   hist=84686
g49mp  Сезонный пропуск                           other                 lots=38   hist=432583
zzwok  Глаз сильной хрюши                         other                 lots=38   hist=26691
dmy6g  Рука шныря                                 other                 lots=37   hist=12425
n4wrw  Компонент брони (Ветеран)                  other                 lots=36   hist=95250
6w906  Набор комопнентов брони (Сталкер)           other                 lots=33   hist=55468
g419n  Голова слабой крысы                        other                 lots=33   hist=74478
00jjk  Часть схемы #3: «Спаннер»                  other                 lots=29   hist=19645
gn1nn  Комплект заводских инструментов            other                 lots=29   hist=9591
m0q6r  Компонент брони (Новичек)                  other                 lots=29   hist=37813
4q7lr  Контейнер с камуфляжем для брони           other                 lots=28   hist=26083
rwvnl  Компонент оружия (Ветеран)                 other                 lots=28   hist=262952
j0g17  Спонсорский подгон                         other                 lots=27   hist=979312
knpzj  Глаз сильного бурелома                     other                 lots=27   hist=30333
2o0gv  Щупальца упыря                              other                 lots=26   hist=47083
5l6n0  Сезонный пропуск + 50 уровней              other                 lots=26   hist=17221
6w92y  Ящик с обородуванием                        other                 lots=26   hist=13907
7l1mr  Набор компонентов брони (Новичек)           other                 lots=25   hist=35334
zzqw2  Аптечка для экстремальных условий           other                 lots=25   hist=6242
kr6kp  ПДА с данными                               other                 lots=24   hist=35710
m01r2  Кейс с обликами «Операции Криостазис»       other                 lots=24   hist=169402
gn1r5  Старый жетон                                other                 lots=23   hist=4273
j0q0l  Компоненты редких сплавов                   other                 lots=22   hist=17681
1r2y6  Десперол                                    other                 lots=21   hist=48479
qjqn4  Голова сильной бестии                       other                 lots=21   hist=35863
drp05  Контейнер 2-го уровня                       other                 lots=20   hist=256699
9mvz   Покрышка                                    misc                  lots=18   hist=81787
gnk55  Соленоид                                    other                 lots=18   hist=84929
p6vw2  Неисследованный предмет                     other                 lots=18   hist=29392
z3ook  Часть схемы #2: «Мечта»                     other                 lots=18   hist=15716
55y2q  Кубик рубика                                other                 lots=17   hist=7971
964o0  Кларинол                                    other                 lots=17   hist=10773
1rlwg  Гладиаторский хабар                         other                 lots=16   hist=720673
wjl0z  Копыто слабого кабана                       other                 lots=16   hist=132513
l0k6o  Зуб мутанта                                 other                 lots=15   hist=11370
2130v  Часть схемы #1: «Рапира»                    other                 lots=14   hist=26644
4q73j  Щупальца сильного упыря                     other                 lots=14   hist=4372
vj3wr  Ящик разбитого отражения                    other                 lots=14   hist=370402
19l02  Набор походной посуды                        other                 lots=13   hist=124666
5533o  Часть схемы #3: «Мечта»                     other                 lots=13   hist=12600
krzzj  Часть схемы #2: «Йорш»                      other                 lots=13   hist=25726
l05r2  Часть схемы #2: «Волна»                     other                 lots=13   hist=41305
vj3dr  Контейнер «Мертвого времени»                other                 lots=13   hist=203670
gnp1n  Часть схемы #3: «Лягуха»                    other                 lots=12   hist=16755
gnppn  Часть схемы #1: «Мечта»                     other                 lots=12   hist=16272
j0gql  Часть схемы #1: «Волна»                     other                 lots=12   hist=42071
j0n4g  Сломаный коготь                             other                 lots=12   hist=34935
m0q5j  Горелка                                      other                 lots=12   hist=7141
vj307  Хвост дикой гончей                          other                 lots=12   hist=15549
194lr  Часть схемы #2 «Лягуха»                     other                 lots=11   hist=19945
l0592  Часть схемы #1: «Уравнитель»                other                 lots=11   hist=17868
wjgm2  Дождевик                                    armor/scientist       lots=11   hist=5021
9d1zq  Часть схемы #1: «Лягуха»                    other                 lots=10   hist=20926
n4w13  Регалий                                      other                 lots=10   hist=5750
0r90y  Кейс с обликами «Черного Рынка»             other                 lots=9    hist=35111
5dv0   Швейные иголки                               misc                  lots=9    hist=8483
96qo0  Кустарная граната                            other                 lots=9    hist=2471
krprj  Коллекционные предметы                       other                 lots=9    hist=6364
0r9wy  Протоартефакт «Холодца»/«Пуха»              other                 lots=8    hist=463412
0rl1r  Сумка экспансивных патронов 5.56 мм         other                 lots=8    hist=6096
1r6rg  Растворитель                                 other                 lots=8    hist=12239
7lw96  Чугунный коленвал                            other                 lots=8    hist=3826
9dzqy  Псалмы «Шепота»                             other                 lots=8    hist=10709
zzw0k  Хвост слабой шавки                           other                 lots=8    hist=583532
210o5  Офицерская фляга                             other                 lots=7    hist=3691
96d6q  Новогодний кейс 1-го уровня                  other                 lots=7    hist=44986
j0ggl  Часть схемы #4: «Йорш»                       other                 lots=7    hist=17295
qj9q6  Пси-блок «Нейрон-33»                          medicine              lots=7    hist=14724
rr3l   Патина                                        misc                  lots=7    hist=6670
zz02n  Сезонный пропуск + 20 уровней                other                 lots=7    hist=2863
00jlk  Часть схемы #4: «Волна»                      other                 lots=6    hist=26878
1r9rr  Новогодний кейс 2-го уровня                  other                 lots=6    hist=12684
21rk5  Сломанные часы                               other                 lots=6    hist=9922
6w9np  Ящик исследователя холода                    other                 lots=6    hist=307292
77319  Часть схемы #3: «Рапира»                     other                 lots=6    hist=21879
96jyz  Red Star Charm                               attachment/accessory  lots=6    hist=1279
dr5n2  Тройник                                      other                 lots=6    hist=3579
qj936  Ноотроп-тирозин                              other                 lots=6    hist=706
z3kqm  Зажигалка                                    other                 lots=6    hist=5224
3g13z  Бутылка                                      other                 lots=5    hist=321
773o9  Часть схемы #3: «Пчела»                      other                 lots=5    hist=17073
9dzdq  Фармппрепарат                                 other                 lots=5    hist=1587
gnk75  Малая поставка торговцу                      other                 lots=5    hist=7412
n4616  Подорожник                                    other                 lots=5    hist=49843
okzqm  Протоартефакт «Омута»                        other                 lots=5    hist=454374
qjqmj  Ящик Наследия Жнеца 2020                     other                 lots=5    hist=67807
y4n40  Медицинские инструменты                      other                 lots=5    hist=6391
3govl  Стальной коленвал                            other                 lots=4    hist=3364
3gqvl  Ящик Проклятого огня                         other                 lots=4    hist=366590
5535q  Ящик с продовольствием                       other                 lots=4    hist=6461
7l1qr  Ящик «Горячих Джеков»                        other                 lots=4    hist=11206
knp5j  Рука слабого шныря                           other                 lots=4    hist=10104
p6q75  Сумка снайперских 7.62 мм                    other                 lots=4    hist=41119
w3z0z  Часть схемы #1: АВТ-40                       other                 lots=4    hist=15812
1rk5r  Охотничий костюм                             other                 lots=3    hist=3654
1rk6g  Бандитский кожак                             armor/clothes         lots=3    hist=4047
5lo6o  Хвост слабой кошки                           other                 lots=3    hist=6385
77363  Контейнер 5-го уровня                        other                 lots=3    hist=394695
96p9y  Магазин 5.56 NATO PMAG, зимний               other                 lots=3    hist=1479
96z1q  Голова сильной крысы                         misc                  lots=3    hist=2168
j5zpg  Протоартефакт «Разряда»/«Застоя»            other                 lots=3    hist=524947
krz5j  Часть схемы #3: АВТ-40                       other                 lots=3    hist=12583
ly9wo  Протоартефакт «Зажигалки»/Мороз             other                 lots=3    hist=501912
m011k  Эротические журналы                          other                 lots=3    hist=4620
n4g62  Протоартефакт «Застоя»                       other                 lots=3    hist=249853
qj303  Кейс с обликами «Марафона мертвецов»        other                 lots=3    hist=124622
rw6jy  Кейс с обликами «Корпорации ZIVCAS»         other                 lots=3    hist=64893
rwvdl  Сумка экспансивных патронов 5.45 мм         other                 lots=3    hist=8168
rwvqg  «Регенератор»                                other                 lots=3    hist=4028
wjlqd  Сумка патронов 5.45 мм                       other                 lots=3    hist=12140
wjwlp  Согревающая сыворотка                        other                 lots=3    hist=5067
1dv1   Моток ниток                                   misc                  lots=2    hist=17547
1r192  Большой набор Черных Фишек                    other                 lots=2    hist=14355
1r5q2  Брелок «Круговорот»                          other                 lots=2    hist=190
55o5o  Посуда                                        other                 lots=2    hist=4206
5lop4  Компонент для обрез Калгана                  other                 lots=2    hist=108576
96v40  Прицельные метки для ПМ                      other                 lots=2    hist=2335
96vwy  Тактическая рукоятка KAC Vertical Foregrip, зимняя  other          lots=2    hist=647
drym2  Ящик с запчастями                            other                 lots=2    hist=9813
g4156  Ящик аномальной стужи                        other                 lots=2    hist=687555
j0gv7  Огромный подарок                             other                 lots=2    hist=4033071
j0q5g  Царский клык                                  other                 lots=2    hist=1838
okd4o  Радиопротектор третьего класса               medicine              lots=2    hist=30691
rw6ly  Протоартефакт «Волчка»                       other                 lots=2    hist=452779
rwv6z  Коготь слабой бестии                          other                 lots=2    hist=18765
wjlg2  Контейнер с оружейными камуфляжем             other                 lots=2    hist=16004
y4n13  Крупная поставка торговцу                     other                 lots=2    hist=591
zz3zk  Новогодний кейс 4-го уровня                   other                 lots=2    hist=28083
177r   Гильзовая болванка                            misc                  lots=1    hist=103
1rvj2  Вертикальная рукоятка ANG4, зимняя           other                 lots=1    hist=559
4q7wl  Сумка патронов 5.56 мм                        other                 lots=1    hist=7215
5lo44  Сумка патронов 9 мм                           other                 lots=1    hist=2634
6w946  Подсумок с индивидуальными аптечками          other                 lots=1    hist=2063
g41dg  Коробка ИРП                                    other                 lots=1    hist=2799
j5qzl  Глаз слабого бурелома                         other                 lots=1    hist=77573
j5z0g  Кейс с обликами «Аномальной Зимы»            other                 lots=1    hist=377327
kn5rp  Кейс с обликами «Арены Ворона»                other                 lots=1    hist=58714
kn9wj  Ложа карабина Мосина, обмотанная             other                 lots=1    hist=1089
kny20  Кустарная осколочная граната                  other                 lots=1    hist=2783
kr25j  Крупнокалиберный самодельный патрон           bullet                lots=1    hist=5
l0552  Часть схемы #1: «Спаннер»                    other                 lots=1    hist=23801
m01w2  Протоартефакт «Батут»                         other                 lots=1    hist=447889
m0qdr  Сумка экспансивных патронов 7.62 мм          other                 lots=1    hist=5875
n4wl1  Ящик прошедшего Бурана                        other                 lots=1    hist=263786
wj033  Кейс с обликами «Аномального Бурана»         other                 lots=1    hist=34079
zzwr9  Сумка патронов 9x39 СП-5                      other                 lots=6    hist=7837
```

Валидны, лотов сейчас 0, но есть история продаж (61 шт., см. полную таблицу с именами/категориями
в разделе «Реализация» ниже — на момент первого прохода в этот блок дока попали только голые id
для краткости, полные данные были в `verify_results.json` с самого начала):
```
0rd7d 0rdld 0rw19 1742 179g 1945q 194gq 1rl3q 1rp4q 21320 3g6nl 3gq5k 49dj 49gj
55oqq 5l134 5ln51 5lo9g 5lp2g 5lrg1 7ljor 7yl7 9696l 96y1w 96zpw 991y 9d10q 9d63z
dmky5 g43pg gnkl5 j5mn7 j5qgl j5qr4 kno60 knp03 ly4ok lyrmq m0p4j m0pqj n3v9
n4321 okp14 okq26 qjq34 qjqk6 qjqz9 rg1z rw1vg rwldv vj2kd y3n00 y3nlw y3nzz
y4ydw y4yww z23y z3o49 z3od9 z3z59 zz95m
```

---

## 2) Не удалось найти / подтвердить — 130 позиций

### A. Вообще нет id ни в одном источнике (15)

Проверено: EXBO-репозиторий (`ru` и `global`), Lunar, stalzone.wiki, stalzone-monitor, обе публичные
вики (fandom, wiki.gg). Ни в одном id не нашёлся.

- Ключ от медицинского сейфа
- Ключ от военного сейфа
- Ключ от научного сейфа
- Ключ от сейфа Зивкаса
- Ключ от сейфа «Шепота»
- Перегрузка (механика сезонного пропуска)
- Уровень сезона (механика сезонного пропуска)
- Большой подарок
- Обычный подарок
- Маленький подарок
- Скромный подарок
- Детектор широкого диапазона «PIONEER-3» (эксклюзив премиум-кейсов)
- Забытые припасы (сезонный кейс, Весна 25)
- Загадочная добыча (сезонный кейс, Осень 25)
- Промерзший хабар (сезонный кейс, Зима 25-26)

### B. Id есть, но API отклоняет — `400 Bad Request` (49)

Вся категория `weapon_modules/module` (47 шт. — перки/модули оружия, не самостоятельный лот
аукциона) + 2 ошибочных id со stalzone.wiki (не настоящие exbo_id):

```
0m8u Дискомфортный          11gb Проектор              24f5 Инертный
3lpx Суммирующий            3nkq Регулятор             53oj Неустойчивый
55ct Компрессор             5cv8 Мгновенный             616z Фиксатор
7f9s Термос                 7vt4 Перфоратор             9qy7 Вариатор
a0mi Комфортный             a9rv Агрессор               agkl Люфтящий
cehv Горизонтальный         cyz5 Пробойник              dh9u Фокусный
elf4 Седатор                exuw Плавный                g897 Экстрактор
gesl Устойчивый             gtrl Гармоничный            h20p Слайдер
iuix Держатель              jh5j Сдвигающий             juns Оператор
l07p Биостабилизатор        lak7 Вертикальный           leq0 Бдительный
mecp Снайпер                n4kx Уходящий               ndfr Дрожащий
nrbn Завершитель            oxme Медлительный           s0gm Резкий
s8yv Палач                  skiz Подвижный              tu09 Отрицающий
ujph Заторможенный          uvxl Охотник                v5d8 Контролер
vgd8 Стрелок                wv23 Нестабильный           za4x Стабильный
zb4r Гаситель                zkx1 Губитель

x22sxr4 Wicked Hedgehog (artefact/other_arts) — мусорный id со stalzone.wiki
x22sxr5 Flicker (artefact/other_arts) — мусорный id со stalzone.wiki
```

### C. Id валиден, но нет ни активных лотов, ни истории продаж (66)

Преимущественно «Поношенные»/«Повреждённые» варианты брони (armor/combat, armor/combined) —
похоже, либо крайне редкие, либо непередаваемые:

```
0r4k9 Поношенный костюм АО-3 «Искатель»       armor/combined
1rkdg Поврежденный АО-2 «Странник»             armor/combined
1rkq2 Поношенный «Скиф-4»                      armor/combined
1rkqg Поношенный «Скиф-2м»                     armor/combined
1rwg2 Мобильный лагерь                          backpacks
3g69l Бронекостюм «Скиф-4б»                    armor/combined
3gdoz Поношенный комбинезон «Сатурн»           armor/scientist
3gp95 Увеличенный магазин для МЦ-558           attachment/mag
3grk1 «Тестовый образец» РМО-93                other
4q9op Поношенный «Зверобой»                    armor/combat
4qlvo Поношенный «Центурион»                   armor/combat
4qnor Поношенная СВД                            weapon/sniper_rifle
553qq Ядерный желатин                           other
5lndo Модифицированный Colt Walker             weapon/pistol
5lrvq Поврежденный «Егерь»                     armor/combat
6olnp Светящаяся слизь                          other
6w0rp Поношенный костюм «Траппер»              armor/combat
6wr2n «Тестовый образец» РПК-16                other
7lr29 «Тестовый образец» ТКБ-0146М             other
7lzw3 Поврежденный комбинезон «Сатурн»         armor/scientist
7ynr  Выстрел гранатометный M2                  grenade
96n5l Поношенный «Легионер»                     armor/combat
96n5y Поношенная «Масть»                        armor/combat
96nml Поношенный АО-2 «Странник»               armor/combined
dj7n  Декомпрессор                              weapon_modules/module (аномалия — единственный модуль без 400)
dmg02 Поношенный «Клептоман»                    armor/combined
dmqzg «Износ»                                   other
g400n «Головорез» ОЦ-62                        other
g4y06 Поношенный бронекостюм «Страйкер»        armor/combat
g4yo5 Поврежденный «Скиф-4»                     armor/combined
g4yo6 Поношенный «Пахан»                        armor/combined
j5k10 Поношенный комбинезон «Уран»             armor/scientist
j5k6g Поношенный «Изумруд»                      armor/scientist
j5y7g Мобильный лагерь                          containers
kn360 Поношенный «Мул»                          armor/combat
knnop Large-Caliber Handmade Round             consumables/bullet
knqgy Поношенный КИМ-99 «Янтарь»               armor/scientist
knqwp Поношенный «Топаз»                        armor/scientist
ly29k Поношенная L96A1                          weapon/sniper_rifle
lyjzk Поношенный комбинезон «Жнец»             armor/scientist
lyr3k Странный ящик                             misc
m065y Поношенный тяжелый бронекостюм «Восход»  armor/combat
m3pk  Контейнер «Колотун»                       containers
n4rp1 Поношенный бронекостюм «Пересмешник»     armor/combined
n4ry1 Поношенный защитный костюм «Ош»          armor/combat
ok0jm Поношенный «Скиф-4б»                     armor/combined
ok0v6 Поношенный бронекостюм «Сокол»           armor/combined
ok0w6 Поношенный тяжелый бронекостюм «Громила» armor/combat
p6m4w Поношенный АО-4 «Рейдер»                 armor/combined
p6mrw Поношенный защитный костюм «Ворса»       armor/combat
q1m4  Контейнер «Берлога-6у»                    containers
qj1y6 Поношенный «Туз»                          armor/combat
qjokj Поношенный КИМ-99М «Малахит»             armor/scientist
qjor3 Поношенный «Иолит»                        armor/scientist
rwnqv Поврежденный костюм АО-3 «Искатель»      armor/combined
vj1pp Поношенный «Грибник»                      armor/combined
vj1rr Поношенный бронекостюм «Гоплит»          armor/combat
vjrm7 «УЗ»                                      other
wjgp3 Поврежденный «Центурион»                 armor/combat
wjooz «Хренострел»                              other
y35p3 Поношенный «Егерь»                        armor/combat
y3jnk XM8S Арсенала                             weapon/assault_rifle
y3qgz Поношенный АО-6 «Кочевник»               armor/combined
y3qyw ПНВ О1М                                   armor/device
zzy5m Поношенный АО-5 «Пилигрим»               armor/combined
zzy5y Поношенный экзоскелет «Самсон»           armor/combat
```

---

## Дальше

Если решите добавлять 251 подтверждённых в `master_items` — нужен контракт с System Analyst
(откуда брать `name_ru`/`name_en`/`category` для upsert — сейчас это разные форматы из разных
источников, см. таблицу выше) и решение по backend-dev на реализацию upsert/миграции при
необходимости.

---

## Реализация: добавление 251 предмета в `master_items`

### Исследование (что уже проверено в коде)

**1. Модель `MasterItem` (`backend/app/models/models.py:67-92`).** Единственное обязательное
поле — `item_id` (`unique=True, nullable=False`). Всё остальное (`name_ru`, `name_en`, `category`,
`color`, `icon_path`, `bind_state`, `can_be_batch_traded` default `True`, `on_auction` nullable,
`auction_checked_at`, `history_total`, `lots_total`) — nullable или с дефолтом. В таблице уже
существуют строки с `NULL` в `color`/`icon_path` (например `dm6l2` — см. `docs/NOTES.md`, пункт про
«внедрение Design v5»: «предмет `dm6l2` без иконки — фолбэк-буква»), т.е. частично заполненные
записи — не аномалия, а штатная ситуация в текущей БД.

**2. Фильтр каталога `GET /items` (`backend/app/api/v1/endpoints/items.py:88-101`).** Ровно тот же
эндпоинт используется и `CatalogPage.tsx`, и автокомплитом поиска предмета на странице «Лоты»
(`LotsPage.tsx:273` → `api.get('/items', { search, page_size: 8 })`) — **отдельного «раздела лоты» с
собственным списком предметов нет**, оба места читают один и тот же `master_items` через один и тот
же фильтр. Условие видимости:

```python
or_(MasterItem.on_auction.is_not(False), _gear_exempt),
or_(MasterItem.on_auction.is_(True), MasterItem.bind_state.is_(None), MasterItem.bind_state.notin_(...)),
```

Если проставить `on_auction=True` — обе ветки `or_` удовлетворяются автоматически, независимо от
`bind_state`/`category`. Это ровно та же семантика, что уже применяется в разовой задаче
`audit_auction_status` (`docs/tasks/audit-on-auction-status.md`, задача из `docs/NOTES.md` ←
2026-07-24): «>0 из `/history` → TRUE; иначе >0 из `/lots` → TRUE; оба 0 → FALSE». Мы уже прогнали
251 id через ровно эти же два эндпоинта (`get_auction_lots` + `get_auction_history`) — то есть
фактически **уже выполнили аудит вручную** для этих строк, и можем сразу проставить его результат.

**3. `github_parser.py::sync_catalog()`.** При обычном синке `on_conflict_do_update` обновляет по
`item_id`: `name_ru/name_en/category/color/icon_path/bind_state/can_be_batch_traded/last_updated` —
**`on_auction`/`auction_checked_at`/`history_total`/`lots_total` синк не трогает** (эти поля —
собственность `audit_auction_status`, не GitHub-парсера). Значит если EXBO когда-нибудь официально
добавит один из этих 251 id в `listing.json`, обычный `refresh-catalog` аккуратно обновит
метаданные (появится настоящий `name_en`/`icon_path`/`color`/`bind_state`) поверх наших вставленных
строк и не тронет `on_auction` — конфликта источников правды нет. **Уточнение после ревизии
иконок (см. ниже):** если для конкретного id мы сами скачали и проставили локальную иконку
(`icon_path = '/arsenal-icons/{id}.webp'`), а EXBO потом добавит этот id официально — `sync_catalog`
перезапишет `icon_path` на официальный GitHub-путь. Это желаемое поведение (официальный источник
важнее самодельного), но означает, что скачанный файл в `frontend/public/arsenal-icons/` в этот
момент осиротеет (никто на него больше не будет ссылаться) — не баг, просто мёртвый файл; чистить
не обязательно (единицы КБ), но можно упомянуть в комментарии скрипта.

**4. Категории — сюрприз: специальной нормализации почти не требуется.** Проверил через
`docker exec ... psql` реальное распределение `category` в текущих 2328 строках:

```
other 780 · misc 330 · bullet 137 · weapon/assault_rifle 90 · attachment/barrel 72 ·
weapon/melee 69 · attachment/mag 60 · armor/combat 57 · armor/combined 36 · containers 32 ·
armor/scientist 27 · backpacks 21 · grenade 15 · armor/clothes 11 · medicine 3 · attachment/accessory 18 ·
attachment/forend 22 · armor/device 8 · weapon/sniper_rifle 51 · ...
```

Все категории, встречающиеся в 251 подтверждённых строках (`other`, `misc`, `bullet`, `medicine`,
`armor/scientist`, `armor/clothes`, `armor/device`, `armor/combat`, `armor/combined`,
`attachment/accessory`, `attachment/forend`, `containers`, `weapon/sniper_rifle`) — это **уже
существующие в БД топ-уровневые/под-категории**, буквально совпадающие строки, не синонимы для
маппинга. Специальный шаг «маппинг category → формат фронта» **не нужен** — категория пишется как
есть.

**5. `can_be_batch_traded`** — вычисляется той же логикой, что в `_parse_item()`
(`github_parser.py:64`, `top_category not in _SINGLE_CATEGORIES`, где `_SINGLE_CATEGORIES =
{"weapon", "armor", "attachment", "weapon_modules", "backpacks"}`), для консистентности с уже
синкнутыми предметами.

### Вывод: правда ли «просто обновить БД» — ДА, с уточнением

`GET /items` и поиск на странице «Лоты» сразу подхватят новые строки без единой правки кода
бэкенда/фронтенда **в части фильтра/названия/категории**, если у новой строки `on_auction=TRUE` —
фильтр уже умеет деградировать на `NULL`. Страница «Лоты» при выборе предмета делает **живой**
запрос к Stalcraft API (`GET /lots/{item_id}`, `backend/app/api/v1/endpoints/lots.py:205`), а не
читает из `sales_history`/`collected_data` — значит актуальные лоты появятся сразу, без зависимости
от Celery-коллектора (watchlist-центричен, не тронет новые предметы, пока их никто не добавит в
«Избранное» — ожидаемое поведение, как и для остальных 2328 предметов).

**Единственное исключение из «совсем без правок кода» — иконки** (см. решение пользователя ниже):
для 32 id, у которых нашлась реально скачиваемая иконка, требуется **одна точечная правка**
`frontend/src/utils/i18n.ts::iconUrl()` + новая папка со статикой во фронтенде. Остального
(`items.py`, `github_parser.py`, модели, `CatalogPage.tsx`, `LotsPage.tsx`, `ItemIcon.tsx`) правки
по-прежнему не касаются.

---

### Ревизия по ответам пользователя (закрывает вопросы 1–5 из первой версии плана)

**Вопрос 1 (опечатки) — подтверждено, исправляем.** Полный список найденных опечаток (объективные
орфографические ошибки, не стилистика):

| id | было | стало |
|---|---|---|
| `vj31g` | «Набор компонентов оружия(Новичек)» | «Набор компонентов оружия (Новичок)» |
| `j5q74` | «Компонент оружия (Новичек)» | «Компонент оружия (Новичок)» |
| `6w906` | «Набор комопнентов брони (Сталкер)» | «Набор компонентов брони (Сталкер)» |
| `6w92y` | «Ящик с обородуванием» | «Ящик с оборудованием» |
| `j0n4g` | «Сломаный коготь» | «Сломанный коготь» |
| `9d63z` | «Караманные деньги» | «Карманные деньги» |
| `194gq` | «Сталкераская простецкая мишура» | «Сталкерская простецкая мишура» |
| `z3o49` | «Сталкераская редкая мишура» | «Сталкерская редкая мишура» |

(Последние три найдены при разборе тира 2, см. ниже — не были видны в компактной версии дока с
голыми id.) Идут в `arsenal_items.json` уже в исправленном виде.

**Вопрос 2 (61 позиция «lots=0, history>0» без имени/категории) — снят, гипотезы о пробеле не
было.** Полные данные лежали в `verify_results.json` (scratchpad) с самого начала; в доке был
показан только компактный список голых id для краткости. Извлёк оттуда все нужные поля —
повторный проход по источникам не понадобился. Заодно уточнилось количество: в блоке было **61**
id, а не 62 (я неверно посчитал строки при первом чтении дока) — **190 + 61 = 251 ровно**,
расхождение из вопроса 5 старой версии плана закрыто, пересчитывать/доискивать ничего не нужно.

Полная таблица тира 2 (61 id, `lots_total=0` у всех, `history_total` — реальное значение, все
уже с `on_auction=TRUE` по правилу «история>0 → торгуется»):

```
0rd7d  Радиопротектор первого класса                medicine               hist=12779
0rdld  «Термобарьер» третьего класса                medicine               hist=4836
0rw19  Ящик гранат «Гудрон»                         misc                   hist=95994
1742   Пулевая болванка                             misc                   hist=88
179g   Заготовка для гильзы                         misc                   hist=3854
1945q  Игрушка-подшипник диггеров                   other                  hist=955
194gq  Сталкерская простецкая мишура                other                  hist=741
1rl3q  Старые детали (донатные)                     other                  hist=81518
1rp4q  Прибор ночного видения                       armor/device           hist=246
21320  Контейнер 3-го уровня                        other                  hist=57827
3g6nl  Маскировочный костюм «Смородина»             armor/combat           hist=10260
3gq5k  Ящик «Дубаков»                               other                  hist=12562
49dj   Контейнер «Берлога-6у»                       containers             hist=17105
49gj   «КЗС-4»                                       containers             hist=101
55oqq  Значительная поставка торговцу               other                  hist=786
5l134  NVD-11 Export                                armor/device           hist=1320
5ln51  Поношенная СВТ-40                             weapon/sniper_rifle    hist=730
5lo9g  Баррикада из части урала                     other                  hist=586
5lp2g  Сложенный приклад                            other                  hist=217
5lrg1  Бронекостюм «Пахан»                          armor/combined         hist=780
7ljor  Брелок «Летучая мышь»                        other                  hist=543
7yl7   Рюкзак Errand Junior                         containers             hist=4406
9696l  Поношенный СКС                                weapon/sniper_rifle    hist=811
96y1w  Кустарный ПНВ                                armor/device           hist=2413
96zpw  Старые детали (не донатные)                  other                  hist=325475
991y   Прессованная заготовка гильзы                misc                   hist=106
9d10q  Военный радиопередатчик                      other                  hist=3
9d63z  Карманные деньги                             other                  hist=108650
dmky5  «ClearMind+»                                  medicine               hist=20406
g43pg  ПНВ 2-го поколения                            armor/device           hist=4542
gnkl5  Туалетная бумага                              other                  hist=10215
j5mn7  «Термобарьер» второго класса                  medicine               hist=4289
j5qgl  Коготь сильной бестии                         other                  hist=132094
j5qr4  Сумка экспансивных патронов 9 мм              other                  hist=1402
kno60  Пси-блок «Нейрон-22»                          medicine               hist=61634
knp03  Сумка патронов 7.62 мм                        other                  hist=6777
ly4ok  Цевье для Сайга-12К                           attachment/forend      hist=251
lyrmq  Сумка дроби 12x76 мм                          other                  hist=2008
m0p4j  Радиопротектор второго класса                 medicine               hist=13097
m0pqj  Пси-блок «Нейрон-11»                          medicine               hist=3031
n3v9   Контейнер «Пасека»                            containers             hist=260
n4321  Скин «Диверсант»                              other                  hist=40
okp14  Ящик картечи 12x76 мм                         other                  hist=2570
okq26  Ящик гранат «Хворь»                           misc                   hist=35094
qjq34  Щупальца слабого упыря                        other                  hist=91165
qjqk6  Военная баррикада                             other                  hist=86
qjqz9  Газовый баллон                                other                  hist=816
rg1z   «КЗС-4у»                                      containers             hist=44156
rw1vg  «Термобарьер» первого класса                  medicine               hist=2176
rwldv  Ящик гранат «Вьюга»                           misc                   hist=62951
vj2kd  Кастомный AA-12                               other                  hist=1
y3n00  Глаз слабой хрюши                             other                  hist=89685
y3nlw  Сумка картечи 12x76 мм                         other                  hist=1605
y3nzz  Горелка (с щитком)                             other                  hist=653
y4ydw  Простецкая мишура диггеров                     other                  hist=761
y4yww  Артефакт-игрушка Куриный бог                   other                  hist=802
z23y   Форма пули                                     misc                   hist=1877
z3o49  Сталкерская редкая мишура                      other                  hist=1210
z3od9  Простая гирлянда диггеров                      other                  hist=738
z3z59  Обычная поставка торговцу                      other                  hist=937
zz95m  Магазин 7.62 бакелитовый, обмотанный           other                  hist=1265
```

(имена приведены уже с исправленными опечатками — `y3nzz` было «Горелка(с щитком)», добавлен
пробел перед скобкой заодно с общей нормализацией пунктуации при вставке в `arsenal_items.json`).

Все категории тира 2 (`medicine`, `misc`, `other`, `armor/device`, `containers`,
`weapon/sniper_rifle`, `armor/combat`, `armor/combined`, `attachment/forend`) — существующие в БД,
маппинг не нужен, аналогично тиру 1.

**Вопрос 3 (66 позиций тира C) — подтверждено, включаем с `on_auction=FALSE`.** План без изменений
относительно предыдущей версии.

**Вопрос 4 (иконки) — пользователь выбрал «скачать и хранить у себя», не хотлинк и не `NULL`.**
Полный аудит и архитектурное решение — отдельный раздел ниже.

---

### Иконки: аудит доступности и архитектурное решение

**Методология.** Источник: `lunar_listing.json` (собственный листинг Lunar, тот же формат
`data`/`icon`/`name`/`color`/`status`, что у EXBO, но с `icon`-путями вида `/icons/<category>/<id>.webp`
— расширение `.webp`, не `.png`). Для каждого из 251 подтверждённого id (190 тир 1 + 61 тир 2)
извлёк `icon` по совпадению `item_id` (stem пути `data`), затем прогнал реальный `curl -o /dev/null -w
%{http_code}` по `https://lunar-zone.ru/database/STALCRAFT/ru{icon}` для каждого (с ретраями на
транзиентные таймауты при параллельных запросах — часть первых ответов «000» на поверку оказались
не 404, а либо настоящими 404, либо (2 шт.) настоящими 200 после повторного одиночного запроса).

**Итог по всем 251:**
- **32 id (12.7%) — реально отдают `200 OK`**, файл можно скачать прямо сейчас.
- **218 id (86.9%) — `404`**: путь в `lunar_listing.json` заполнен (значит формально «должен
  быть»), но самого файла на CDN Lunar нет. Подтверждает наблюдение пользователя: у Lunar
  рассинхрон между метаданными листинга и реально загруженными на их сторонний CDN
  (`s3.ru-3.storage.selcloud.ru` / `lunar-client.s3...`, судя по `Content-Security-Policy` их же
  ответа) файлами — похоже, они заливают иконки только для «основных» предметов, а не для всех,
  что перечислены в листинге.
- **1 id (`96jyz`, Red Star Charm) — в `lunar_listing.json` нет записи вообще** (не только иконки —
  предмета там нет, ожидаемо: этот id найден только на stalzone.wiki).

**Важное наблюдение:** категория `medicine` — 100% покрытие (все 10 из 10 предметов с категорией
`medicine` среди подтверждённых 251 отдают `200`). По остальным категориям срез случайный,
закономерности нет.

**Полный список 32 id с рабочей иконкой** (готов для скачивания и записи в `arsenal_items.json`):

```
id      name_ru                                category           lunar path
3gq6k   Набор компонентов оружия (Мастер)      other              /icons/other/3gq6k.webp
y4g93   Фильтр                                 other              /icons/other/y4g93.webp
y4gr3   Крупный артефактный фрагмент           other              /icons/other/y4gr3.webp
z3wgm   Запчасти для ПДА                       other              /icons/other/z3wgm.webp
krpnp   Лоскут светящейся кожи                 other              /icons/other/krpnp.webp
007oy   Кость мутанта                          other              /icons/other/007oy.webp
wjlzz   Рука сильного шныря                    other              /icons/other/wjlzz.webp
gn1nn   Комплект заводских инструментов        other              /icons/other/gn1nn.webp
knpzj   Глаз сильного бурелома                 other              /icons/other/knpzj.webp
j0q0l   Компоненты редких сплавов              other              /icons/other/j0q0l.webp
qjqn4   Голова сильной бестии                  other              /icons/other/qjqn4.webp
gnk55   Соленоид                               other              /icons/other/gnk55.webp
wjgm2   Дождевик                               armor/scientist    /icons/armor/scientist/wjgm2.webp
qj9q6   Пси-блок «Нейрон-33»                   medicine           /icons/medicine/qj9q6.webp
y4n40   Медицинские инструменты                other              /icons/other/y4n40.webp
drym2   Ящик с запчастями                      other              /icons/other/drym2.webp
okd4o   Радиопротектор третьего класса         medicine           /icons/medicine/okd4o.webp
0rd7d   Радиопротектор первого класса          medicine           /icons/medicine/0rd7d.webp
0rdld   «Термобарьер» третьего класса          medicine           /icons/medicine/0rdld.webp
0rw19   Ящик гранат «Гудрон»                   misc               /icons/misc/0rw19.webp
3g6nl   Маскировочный костюм «Смородина»       armor/combat       /icons/armor/combat/3g6nl.webp
9d10q   Военный радиопередатчик                other              /icons/other/9d10q.webp
dmky5   «ClearMind+»                            medicine           /icons/medicine/dmky5.webp
j5mn7   «Термобарьер» второго класса           medicine           /icons/medicine/j5mn7.webp
kno60   Пси-блок «Нейрон-22»                   medicine           /icons/medicine/kno60.webp
ly4ok   Цевье для Сайга-12К                    attachment/forend  /icons/attachment/forend/ly4ok.webp
m0p4j   Радиопротектор второго класса          medicine           /icons/medicine/m0p4j.webp
m0pqj   Пси-блок «Нейрон-11»                   medicine           /icons/medicine/m0pqj.webp
n3v9    Контейнер «Пасека»                     containers         /icons/containers/n3v9.webp
okq26   Ящик гранат «Хворь»                    misc               /icons/misc/okq26.webp
rw1vg   «Термобарьер» первого класса           medicine           /icons/medicine/rw1vg.webp
rwldv   Ящик гранат «Вьюга»                    misc               /icons/misc/rwldv.webp
```

Полный источник URL для скачивания: `https://lunar-zone.ru/database/STALCRAFT/ru` + `<lunar path>`
(например `https://lunar-zone.ru/database/STALCRAFT/ru/icons/medicine/qj9q6.webp`).

**Остальные 219 (218 подтверждённо `404` + 1 `96jyz` без записи) — `icon_path=NULL`**, фолбэк-буква
(`ItemIcon.tsx`, уже реализовано и обкатано на `dm6l2`). Дальнейший поиск иконок для них у других
community-источников (stalzone.wiki, stalzone-monitor) в этот заход не входит — отдельный
follow-up, если понадобится позже.

#### Архитектурное решение: где хранить скачанные иконки

Рассмотрел два варианта.

**Вариант A — backend static mount.** Класть файлы в `backend/app/static/arsenal-icons/`, добавить
`app.mount("/static", StaticFiles(...))` в `main.py`, отдавать по бэкенд-URL. Требует: новый mount в
FastAPI, новый route в `Caddyfile` (сейчас там только `/api/*`, `/docs*`, `/openapi.json` и общий
`handle` на фронтенд — `/static/*` пришлось бы либо добавлять отдельным `handle`, либо заворачивать
через `/api/`), `iconUrl()` пришлось бы резолвить через базовый URL backend/API (которого сейчас в
явном виде в `i18n.ts` нет — есть только в axios-инстансе `api`). Больше движущихся частей ради 32
файлов.

**Вариант B — статика фронтенда, `frontend/public/arsenal-icons/{item_id}.webp` (рекомендую).**
Vite уже отдаёт всё из `public/` как есть с корня (в репозитории уже есть прецедент:
`frontend/public/favicon.svg`, `icon-192.png`, `logo.png` и т.д. — PWA-иконки лежат ровно так же).
Проверил `frontend/nginx.conf`: `location / { try_files $uri $uri/ /index.html; }` — реальный файл
по пути (`/arsenal-icons/lypmj.webp`) будет отдан напрямую, до какого-либо фолбэка на
`index.html`, без единой правки конфига. `Caddyfile` заворачивает всё, что не `/api/*`/`/docs*`, на
`frontend:80` — тоже без изменений. Zero новой инфраструктуры и деплой-шагов.

Плоская структура без category-подпапок — `item_id` уже уникальный ключ в БД, не нужно тащить
category в путь. `icon_path` в БД для этих 32 строк = `/arsenal-icons/{item_id}.webp` (например
`/arsenal-icons/qj9q6.webp`).

**Выбираю Вариант B** — меньше инфраструктурных изменений, использует уже существующий механизм
раздачи статики, не требует деплой-шагов сверх обычной пересборки фронтенда.

#### Точечная правка `iconUrl()` (единственная правка кода в этой задаче)

`frontend/src/utils/i18n.ts:134-140` сейчас:

```ts
const ICON_BASE = 'https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru'

export function iconUrl(iconPath: string | null | undefined): string | null {
  if (!iconPath) return null
  return `${ICON_BASE}${iconPath}`
}
```

Нужно: если `iconPath` уже указывает на локальную статику (наш собственный неймспейс
`/arsenal-icons/...`, не пересекается ни с одним реальным путём EXBO-каталога вида
`/icons/<category>/<id>.png`) — не конкатенировать `ICON_BASE`, отдавать как есть (браузер
резолвит relative-путь от текущего origin фронтенда — сработает и в dev, и в проде):

```ts
export function iconUrl(iconPath: string | null | undefined): string | null {
  if (!iconPath) return null
  if (iconPath.startsWith('/arsenal-icons/')) return iconPath
  return `${ICON_BASE}${iconPath}`
}
```

Три строки, один файл, один новый префикс-неймспейс. `ItemIcon.tsx` не трогаем — он уже принимает
готовый `src` и не знает, откуда тот взялся.

**Мелкая доп. рекомендация (не блокирует, на усмотрение frontend-dev):** в `frontend/nginx.conf`
regex кэшируемых расширений (`\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$`) не включает
`webp` — новые файлы будут отдаваться без заголовка `Cache-Control: public, immutable` (не
сломано, просто не оптимально закэшировано). Можно добавить `webp` в список заодно.

### Обновлённый план

1. **`backend/app/scripts/data/arsenal_items.json`** — 251 запись (190 тир 1 + 61 тир 2, обе группы
   с исправленными опечатками и `on_auction=TRUE`) + 66 записей тира C (`on_auction=FALSE`,
   `lots_total=0`, `history_total=0`) = **317 записей всего**. Поля: `item_id, name_ru, category,
   lots_total, history_total, on_auction`. Для 32 id из списка выше — дополнительно поле
   `icon_path = "/arsenal-icons/{item_id}.webp"`, для остальных 285 — `icon_path` отсутствует/`null`.
2. **Скачать 32 файла** (одноразово, вручную или маленьким скриптом-хелпером, не обязательно частью
   `import_arsenal_items.py`) в `frontend/public/arsenal-icons/{item_id}.webp` по URL из таблицы
   выше. Формат менять не нужно (Lunar уже отдаёт `.webp`, конвертация не требуется).
3. **Правка `frontend/src/utils/i18n.ts::iconUrl()`** — 3 строки, см. выше.
4. **`backend/app/scripts/import_arsenal_items.py`** (без изменений относительно предыдущей версии
   плана, кроме того что данные теперь полные на все 317 строк): читает JSON, для тира 1/2
   `on_auction=True`/`can_be_batch_traded` по логике `_parse_item()`, `auction_checked_at=now()`, для
   тира C `on_auction=False` аналогично; `name_en=None`, `color=None`, `bind_state=None` для всех;
   `icon_path` — из JSON, где есть, иначе `NULL`; `INSERT ... ON CONFLICT (item_id) DO NOTHING`.
5. Ничего не меняется в `items.py`, `github_parser.py`, моделях, `CatalogPage.tsx`, `LotsPage.tsx`,
   `ItemIcon.tsx`.

### Затронутые файлы (обновлено)

- `backend/app/scripts/data/arsenal_items.json` (новый, данные, 317 записей)
- `backend/app/scripts/import_arsenal_items.py` (новый, разовый скрипт)
- `frontend/public/arsenal-icons/*.webp` (новые, 32 файла, скачанные один раз)
- `frontend/src/utils/i18n.ts` (точечная правка `iconUrl()`, 1 функция)
- `frontend/nginx.conf` (опционально: добавить `webp` в regex кэшируемых расширений)
- Остальной код (`items.py`, `github_parser.py`, `models.py`, `CatalogPage.tsx`, `LotsPage.tsx`,
  `ItemIcon.tsx`) — без изменений

### Документация для обновления (tech-writer, после реализации)

- `docs/NOTES.md`: пункт о добавлении 317 предметов в каталог (251 торгуемых + 66 непродаваемых-но-
  видимых-в-gear-исключении), дата, коммит, итоговый count в `master_items`, +32 локальных иконки.
- `docs/DATABASE.md`: сноска, что часть `master_items` заведена не через `sync_catalog`, а разовым
  скриптом (`name_en`/`color`/`bind_state` всегда `NULL` до тех пор, пока EXBO официально не
  добавит id; `icon_path` — либо `NULL`, либо собственный локальный путь `/arsenal-icons/...`, не
  GitHub).

### Открытые вопросы / требует подтверждения (актуальный список)

1. ~~Опечатки~~ — закрыто, список исправлений см. выше.
2. ~~61 позиция без данных~~ — закрыто, данные были в `verify_results.json`, гэпа не было.
3. ~~66 позиций тира C~~ — закрыто, включаем с `on_auction=FALSE`.
4. **Иконки — подтвердите конкретный список из 32 id/файлов выше** перед скачиванием (лицензионный
   нюанс: файлы — это игровые ассеты, извлечённые community-проектом Lunar, юридически по той же
   логике, что мы уже полагаемся на хотлинк EXBO-иконок «как есть»; репаблишить их копией у себя —
   не более рискованно, чем текущий хотлинк, но это уже не хотлинк, а физическая копия на нашей
   инфраструктуре — если это важно, стоит явно проговорить). Если согласны — backend-dev/frontend-dev
   скачивают ровно эти 32 файла, остальные 219 остаются на фолбэк-букве.
5. **66 позиций тира C — тоже пробовать искать иконки?** Не аудировал (аудит проводился только для
   251 подтверждённых по прямому запросу). Если да — отдельный проход по тому же алгоритму, можно
   сделать сразу вместе с текущим (недорого), просто явно скажите.

### Иконки тира C (66 позиций) — аудит выполнен, вопрос 5 закрыт

Пользователь подтвердил вопросы 4 и 5 («да» на оба). Прогнал тот же алгоритм (Lunar `icon` из
`lunar_listing.json` + реальный HTTP-запрос) по всем 66 id тира C. Из-за нестабильности curl в
цикле bash (см. ниже) пришлось переделать проверку на Python `urllib` — после этого результат стал
стабильным и воспроизводимым при повторных прогонах.

**Итог по 66:**
- **8 id (12.1%) — реально `200 OK`**, доступны для скачивания.
- **56 id — `404`** (тот же паттерн рассинхрона листинга/CDN, что и в тире 1/2).
- **2 id — нет записи `icon` в `lunar_listing.json` вообще.**

**Список 8 доступных иконок тира C:**

```
id      name_ru                          category     lunar path
3grk1   «Тестовый образец» РМО-93        other        /icons/other/3grk1.webp
6wr2n   «Тестовый образец» РПК-16        other        /icons/other/6wr2n.webp
7lr29   «Тестовый образец» ТКБ-0146М     other        /icons/other/7lr29.webp
dmqzg   «Износ»                          other        /icons/other/dmqzg.webp
g400n   «Головорез» ОЦ-62                other        /icons/other/g400n.webp
q1m4    Контейнер «Берлога-6у»           containers   /icons/containers/q1m4.webp
vjrm7   «УЗ»                             other        /icons/other/vjrm7.webp
wjooz   «Хренострел»                     other        /icons/other/wjooz.webp
```

**Итоговый объём иконок ко всей задаче: 32 (тир 1/2) + 8 (тир C) = 40 файлов**
в `frontend/public/arsenal-icons/{item_id}.webp`.

**Техническая заметка (не блокирует, для сведения backend-dev/frontend-dev):** проверка тира C
через `curl` в цикле bash сначала стабильно возвращала `000` (обрыв соединения) на всех 66 запросах
подряд, включая повторы с задержкой — при этом единичный ручной `curl`-запрос к тому же URL сразу
после отрабатывал нормально (`200`/`404`). Похоже на анти-бот/rate-limit реакцию Cloudflare именно
на паттерн «много последовательных запросов из одного процесса» через `curl`, а не на IP в целом.
Переход на Python `urllib.request` (тот же интервал между запросами, тот же User-Agent) сразу дал
стабильный результат без единого `000`. Если кто-то будет добавлять ещё автоматических проверок
Lunar — лучше использовать `urllib`/`httpx`, не голый `curl` в bash-цикле.

---

### Маршрутизация по агентам

1. ~~Подтверждение пользователя по вопросам 4–5~~ — получено, оба «да». Аудит тира C выполнен (см.
   выше) — итоговый список иконок теперь полный: 40 файлов (32 + 8).
2. `backend-dev` — собирает `arsenal_items.json` (317 записей) из данных этого документа +
   `verify_results.json`, пишет и запускает `import_arsenal_items.py`, проверяет
   `GET /items?search=...`.
3. `frontend-dev` — скачивает 40 `.webp` (32 из тира 1/2 + 8 из тира C) в
   `frontend/public/arsenal-icons/`, правит `iconUrl()`, опционально дополняет regex в
   `nginx.conf`.
4. `qa-tester` — точечная проверка: несколько id из каждого тира видны в Каталоге и в поиске
   «Лоты»; из 40 «иконочных» id хотя бы 3-4 показывают реальную картинку, не фолбэк-букву; у
   остальных фолбэк работает без ошибок в консоли.
5. `tech-writer` — обновляет `docs/NOTES.md`/`docs/DATABASE.md` после подтверждения результата.

/** DemonX branded post processors, as supplied (the original .pp text, kept as it is). Loaded by post.ts. */

export const PP_CUBIKO = `+================================================
+
+    DemonX - Genmitsu Cubiko GRBL post processor
+
+================================================
+
+ History
+
+ Who      When        What
+ ======== ==========  ===========================
+ Shawn     06/21/2026  Initial Draft for DemonX Software
+ Shawn     06/21/2026  Added Arc Moves, Spindle Off, & Cleaned Footer
+================================================

POST_NAME = "DemonX - Genmitsu Cubiko (mm) (*.gcode)"
FILE_EXTENSION = "gcode"
UNITS = "MM"
RAPID_PLUNGE_TO_STARTZ = "YES"

+------------------------------------------------
+ Line terminating characters
+------------------------------------------------
LINE_ENDING = "[13][10]"

+------------------------------------------------
+ Block numbering (Turned off by default for GRBL)
+------------------------------------------------
LINE_NUMBER_START     = 0
LINE_NUMBER_INCREMENT = 10
LINE_NUMBER_MAXIMUM   = 999999

+================================================
+ Formating for variables
+================================================
VAR LINE_NUMBER = [N|A|N|1.0]
VAR SPINDLE_SPEED = [S|A|S|1.0]
VAR FEED_RATE = [F|C|F|1.1]
VAR X_POSITION = [X|C|X|1.3]
VAR Y_POSITION = [Y|C|Y|1.3]
VAR Z_POSITION = [Z|C|Z|1.3]
VAR ARC_CENTRE_I_INC_POSITION = [I|A|I|1.3]
VAR ARC_CENTRE_J_INC_POSITION = [J|A|J|1.3]
VAR X_HOME_POSITION = [XH|A|X|1.3]
VAR Y_HOME_POSITION = [YH|A|Y|1.3]
VAR Z_HOME_POSITION = [ZH|A|Z|1.3]

+================================================
+ Block definitions for toolpath output
+================================================

+---------------------------------------------------
+ Commands output at the start of the file
+---------------------------------------------------
begin HEADER
  "G17"
  "G21"
  "G90"
  "G0[ZH]"
  "G0[XH][YH]"
  "[S]M3"
  "G4 P3.0"

+---------------------------------------------
+ Commands output for a dwell move
+---------------------------------------------
begin DWELL_MOVE
  "G04 [DWELL]"

+---------------------------------------------------
+ Commands output for rapid moves
+---------------------------------------------------
begin RAPID_MOVE
  "G0[X][Y][Z]"

+---------------------------------------------------
+ Commands output for the first feed rate move
+---------------------------------------------------
begin FIRST_FEED_MOVE
  "G1[X][Y][Z][F]"

+---------------------------------------------------
+ Commands output for feed rate moves
+---------------------------------------------------
begin FEED_MOVE
  "G1[X][Y][Z]"

+---------------------------------------------------
+ Commands output for clockwise arc moves
+---------------------------------------------------
begin FIRST_CW_ARC_MOVE
  "G2[X][Y][I][J][F]"

begin CW_ARC_MOVE
  "G2[X][Y][I][J]"

+---------------------------------------------------
+ Commands output for counterclockwise arc moves
+---------------------------------------------------
begin FIRST_CCW_ARC_MOVE
  "G3[X][Y][I][J][F]"

begin CCW_ARC_MOVE
  "G3[X][Y][I][J]"

+---------------------------------------------------
+ Commands output at the end of the file
+---------------------------------------------------
begin FOOTER
  "M5"
  "G0[ZH]"
  "G0[XH][YH]"
  "M2"
`;

export const PP_BABY = `+================================================
+
+  DemonX - Baby CNC 3018 GRBL post processor
+
+================================================
+
+ History
+
+ Who      When        What
+ ======== ==========  ===========================
+ Shawn     06/21/2026  Initial setup of 3018 PP for DemonX CNC
+ Shawn     06/21/2026  Added Arc Moves, Spindle Off, & Cleaned Footer
+================================================

POST_NAME = "DemonX - Baby CNC 3018 (mm) (*.gcode)"
FILE_EXTENSION = "gcode"
UNITS = "MM"
RAPID_PLUNGE_TO_STARTZ = "YES"

+------------------------------------------------
+ Line terminating characters
+------------------------------------------------
LINE_ENDING = "[13][10]"

+------------------------------------------------
+ Block numbering (Turned off by default for GRBL)
+------------------------------------------------
LINE_NUMBER_START     = 0
LINE_NUMBER_INCREMENT = 10
LINE_NUMBER_MAXIMUM   = 999999

+================================================
+ Formating for variables
+================================================
VAR LINE_NUMBER = [N|A|N|1.0]
VAR SPINDLE_SPEED = [S|A|S|1.0]
VAR FEED_RATE = [F|C|F|1.1]
VAR X_POSITION = [X|C|X|1.3]
VAR Y_POSITION = [Y|C|Y|1.3]
VAR Z_POSITION = [Z|C|Z|1.3]
VAR ARC_CENTRE_I_INC_POSITION = [I|A|I|1.3]
VAR ARC_CENTRE_J_INC_POSITION = [J|A|J|1.3]
VAR X_HOME_POSITION = [XH|A|X|1.3]
VAR Y_HOME_POSITION = [YH|A|Y|1.3]
VAR Z_HOME_POSITION = [ZH|A|Z|1.3]

+================================================
+ Block definitions for toolpath output
+================================================

+---------------------------------------------------
+ Commands output at the start of the file
+---------------------------------------------------
begin HEADER
  "G17"
  "G21"
  "G90"
  "G0[ZH]"
  "G0[XH][YH]"
  "[S]M3"
  "G4 P3.0"

+---------------------------------------------
+ Commands output for a dwell move
+---------------------------------------------
begin DWELL_MOVE
  "G04 [DWELL]"

+---------------------------------------------------
+ Commands output for rapid moves
+---------------------------------------------------
begin RAPID_MOVE
  "G0[X][Y][Z]"

+---------------------------------------------------
+ Commands output for the first feed rate move
+---------------------------------------------------
begin FIRST_FEED_MOVE
  "G1[X][Y][Z][F]"

+---------------------------------------------------
+ Commands output for feed rate moves
+---------------------------------------------------
begin FEED_MOVE
  "G1[X][Y][Z]"

+---------------------------------------------------
+ Commands output for clockwise arc moves
+---------------------------------------------------
begin FIRST_CW_ARC_MOVE
  "G2[X][Y][I][J][F]"

begin CW_ARC_MOVE
  "G2[X][Y][I][J]"

+---------------------------------------------------
+ Commands output for counterclockwise arc moves
+---------------------------------------------------
begin FIRST_CCW_ARC_MOVE
  "G3[X][Y][I][J][F]"

begin CCW_ARC_MOVE
  "G3[X][Y][I][J]"

+---------------------------------------------------
+ Commands output at the end of the file
+---------------------------------------------------
begin FOOTER
  "M5"
  "G0[ZH]"
  "G0[XH][YH]"
  "M2"
`;

export const PP_VACUUM = `+================================================
+
+ DemonX - DemonCarve Vacuum M2 GRBL post processor
+
+================================================
+
+ History
+
+ Who      When       What
+ ======== ========== ===========================
+ EdwardP  28/11/2014 Added arc move support
+ EdwardP  11/02/2015 Commented out arcs as these
+                     slow GRBL performance appear
+                     interpolated anyway
+ EdwardP  18/06/2015 Explicitly set absolute mode (G90)
+ Mark     24/11/2015 Updated for interim 0.9 spec.
+                     Renaming to be machine specific.
+                     Removing M30 from Footer.
+ EdwardP  01/02/2018 Updated according to 1.1 spec
+                     Changed to 1.3 precision
+                     Spindle off (M5) in footer
+ Ferreri  5/7/2018   Added G04 DWELL & M6 TOOLCHANGE
+ Ferreri  12/27/2019 Uncommented arc commands
+ Ferreri 1/25/2020   Ummmm...and related arc variables
+                     Added Rapid Plunge to StartZ
+ ShawnT    4/13/20   Added Pause for spindle Speed
+ ShawnT    6/12/21   Added M7/M9 command for vacuum control
+ ShawnT    5/13/22   Removed M30 and added M2 in footer
+ ShawnT    5/13/22   Removed M6 TOOLCHANGE and Footer to XHYH
+ ShawnT    10/19/26  Moved Rapid Z move after XY Move
+
+ ======== ========== ===========================

POST_NAME = "DemonX - DemonCarve Vacuum M2 (mm) (*.gcode)"

FILE_EXTENSION = "gcode"

UNITS = "MM"

RAPID_PLUNGE_TO_STARTZ = "YES"

+------------------------------------------------
+    Line terminating characters
+------------------------------------------------

LINE_ENDING = "[13][10]"

+------------------------------------------------
+    Block numbering
+------------------------------------------------

LINE_NUMBER_START     = 0
LINE_NUMBER_INCREMENT = 10
LINE_NUMBER_MAXIMUM = 999999

+================================================
+
+    Formatting for variables
+
+================================================

VAR LINE_NUMBER = [N|A|N|1.0]
VAR SPINDLE_SPEED = [S|A|S|1.0]
VAR FEED_RATE = [F|C|F|1.1]
VAR X_POSITION = [X|C|X|1.3]
VAR Y_POSITION = [Y|C|Y|1.3]
VAR Z_POSITION = [Z|C|Z|1.3]
VAR ARC_CENTRE_I_INC_POSITION = [I|A|I|1.3]
VAR ARC_CENTRE_J_INC_POSITION = [J|A|J|1.3]
VAR X_HOME_POSITION = [XH|A|X|1.3]
VAR Y_HOME_POSITION = [YH|A|Y|1.3]
VAR Z_HOME_POSITION = [ZH|A|Z|1.3]

+================================================
+
+    Block definitions for toolpath output
+
+================================================

+---------------------------------------------------
+  Commands output at the start of the file
+---------------------------------------------------

begin HEADER

"M7"
"G17"
"G21"
"G90"
"G0[ZH]"
"G0[XH][YH]"
"[S]M3"
"G4 P5.0"


+---------------------------------------------
+  Commands output for a dwell move
+---------------------------------------------

begin DWELL_MOVE

"G04 [DWELL]"

+---------------------------------------------------
+  Commands output for rapid moves
+---------------------------------------------------

begin RAPID_MOVE


"G0[X][Y]"
"G0[Z]"


+---------------------------------------------------
+  Commands output for the first feed rate move
+---------------------------------------------------

begin FIRST_FEED_MOVE

"G1[X][Y][Z][F]"


+---------------------------------------------------
+  Commands output for feed rate moves
+---------------------------------------------------

begin FEED_MOVE

"G1[X][Y][Z]"


+---------------------------------------------------
+  Commands output for the first clockwise arc move
+---------------------------------------------------

begin FIRST_CW_ARC_MOVE

"G2[X][Y][I][J][F]"


+---------------------------------------------------
+  Commands output for clockwise arc  move
+---------------------------------------------------

begin CW_ARC_MOVE

"G2[X][Y][I][J]"


+---------------------------------------------------
+  Commands output for the first counterclockwise arc move
+---------------------------------------------------

begin FIRST_CCW_ARC_MOVE

"G3[X][Y][I][J][F]"


+---------------------------------------------------
+  Commands output for counterclockwise arc  move
+---------------------------------------------------

begin CCW_ARC_MOVE

"G3[X][Y][I][J]"


+---------------------------------------------------
+  Commands output at the end of the file
+---------------------------------------------------

begin FOOTER

"M5"
"G0[ZH]"
"G0[XH][YH]"
"M9"
"M2"
`;

export const PP_PCB = `+================================================
+
+ DemonX - DemonCarve PCB GRBL post processor
+
+================================================
+
+ History
+
+ Who      When       What
+ ======== ========== ===========================
+ EdwardP  28/11/2014 Added arc move support
+ EdwardP  11/02/2015 Commented out arcs as these
+                     slow GRBL performance appear
+                     interpolated anyway
+ EdwardP  18/06/2015 Explicitly set absolute mode (G90)
+ Mark     24/11/2015 Updated for interim 0.9 spec.
+                     Renaming to be machine specific.
+                     Removing M30 from Footer.
+ EdwardP  01/02/2018 Updated according to 1.1 spec
+                     Changed to 1.3 precision
+                     Spindle off (M5) in footer
+ Ferreri  5/7/2018   Added G04 DWELL & M6 TOOLCHANGE
+ Ferreri  12/27/2019 Uncommented arc commands
+ Ferreri 1/25/2020   Ummmm...and related arc variables
+                     Added Rapid Plunge to StartZ
+ ShawnT    4/13/20   Added Pause for spindle Speed
+ ShawnT    6/12/21   Added M7/M9 command for vacuum control
+ ShawnT    5/13/22   Removed M30 and added M2 in footer
+ ShawnT    5/13/22   Removed M6 TOOLCHANGE and Footer to X400Y400
+ ShawnT    4/12/26   Duplicated for PCB, edits to follow
+                     Changed footer park to behind pcb not X400Y400
+                     Separated Rapid Moves  Z first then XY
+ ShawnT    5/3/26    Commented Out M7 M9 for PCBs.  Not needed.
+ ShawnT    10/19/26  Moved Rapid Z move after XY Move
+
+ ======== ========== ===========================

POST_NAME = "DemonX - DemonCarve PCB (mm) (*.gcode)"

FILE_EXTENSION = "gcode"

UNITS = "MM"

RAPID_PLUNGE_TO_STARTZ = "YES"

+------------------------------------------------
+    Line terminating characters
+------------------------------------------------

LINE_ENDING = "[13][10]"

+------------------------------------------------
+    Block numbering
+------------------------------------------------

LINE_NUMBER_START     = 0
LINE_NUMBER_INCREMENT = 10
LINE_NUMBER_MAXIMUM = 999999

+================================================
+
+    Formatting for variables
+
+================================================

VAR LINE_NUMBER = [N|A|N|1.0]
VAR SPINDLE_SPEED = [S|A|S|1.0]
VAR FEED_RATE = [F|C|F|1.1]
VAR X_POSITION = [X|C|X|1.3]
VAR Y_POSITION = [Y|C|Y|1.3]
VAR Z_POSITION = [Z|C|Z|1.3]
VAR ARC_CENTRE_I_INC_POSITION = [I|A|I|1.3]
VAR ARC_CENTRE_J_INC_POSITION = [J|A|J|1.3]
VAR X_HOME_POSITION = [XH|A|X|1.3]
VAR Y_HOME_POSITION = [YH|A|Y|1.3]
VAR Z_HOME_POSITION = [ZH|A|Z|1.3]

+================================================
+
+    Block definitions for toolpath output
+
+================================================

+---------------------------------------------------
+  Commands output at the start of the file
+---------------------------------------------------

begin HEADER


"G17"
"G21"
"G90"
"G0[ZH]"
"[S]M3"
"G4 P5.0"


+---------------------------------------------
+  Commands output for a dwell move
+---------------------------------------------

begin DWELL_MOVE

"G04 [DWELL]"

+---------------------------------------------------
+  Commands output for rapid moves
+---------------------------------------------------

begin RAPID_MOVE

"G0[X][Y]"
"G0[Z]"



+---------------------------------------------------
+  Commands output for the first feed rate move
+---------------------------------------------------

begin FIRST_FEED_MOVE

"G1[X][Y][Z][F]"


+---------------------------------------------------
+  Commands output for feed rate moves
+---------------------------------------------------

begin FEED_MOVE

"G1[X][Y][Z]"


+---------------------------------------------------
+  Commands output for the first clockwise arc move
+---------------------------------------------------

begin FIRST_CW_ARC_MOVE

"G2[X][Y][I][J][F]"


+---------------------------------------------------
+  Commands output for clockwise arc  move
+---------------------------------------------------

begin CW_ARC_MOVE

"G2[X][Y][I][J]"


+---------------------------------------------------
+  Commands output for the first counterclockwise arc move
+---------------------------------------------------

begin FIRST_CCW_ARC_MOVE

"G3[X][Y][I][J][F]"


+---------------------------------------------------
+  Commands output for counterclockwise arc  move
+---------------------------------------------------

begin CCW_ARC_MOVE

"G3[X][Y][I][J]"


+---------------------------------------------------
+  Commands output at the end of the file
+---------------------------------------------------

begin FOOTER

"M5"
"G0[ZH]"
"G0 X0 Y100"
"M2"
`;

export const BRANDED_POSTS: string[] = [PP_CUBIKO, PP_BABY, PP_VACUUM, PP_PCB];

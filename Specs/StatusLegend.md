I need a plugin, it shall add status button on tool panel. 

When user click it shall open paneld - Status Panel. 

Status panel shall contains field where user can paste values. 

Values comes as list of rows with values splited by Tab symbol 

There might be 4 values per row, or less. Mandatory is first value. 

First value = Tag
Second Value = Status
Third Value = State
Forth Value = Color

Tag is a text field which match to some item name in model. 

Status = is a name of single Status Entity. If not presented, app shall set value "Default" instead. 
State = is a label for group of item with this state. If not set app shall use Tag value as State 
Color = is a color which user may apply to all elements at certain state belongs to certain status. If not presented default color value shall be set - "#DDDDDD" - aka gray color; 

When user paste values it shall be parsed into special entity where every fragment with same name As tag shall be added to group of Status/State. App will show qty of fragments for each state on Legend. 

After user pass, and values has been collected all States shall be listed in the panel as collapsed item, with check box

When user click on State - it shal be unfolded, with list of available states (with color icon before) and qty of matches in the model. (it shall works async, and show up even if matches is not founded yet)

for example data set 

304-SP001   Erection    Fab yellow
440-SP003   Erection    Erected #00ff00
noMatch Erection    NoMatch red

shall be converted into Legend

> [check box] Erection   [trash icon]
    [yellow]    Fab:1
    [#00ff00]   Erected:1
    [red]   NoMatch:0


also shall be Color button. If user check box one of States, and click color button - every match for Status states shall get their colors. 

If user click on State, or State Color icon - application shall select all fragments which was matched with state tags. 

User also shall be able to delete Status, add trash icon

Finally about colors, user shall be able to define Color as "#00ff00" - hex color value, or as per this list of default colors:
red, green, blue, yellow, magenta, cyan, pink, lime, coral, gray, white, black, maroon... some other values might be added later. 


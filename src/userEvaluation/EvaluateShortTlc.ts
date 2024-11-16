import { Comment, Post, User } from "@devvit/public-api";
import { CommentSubmit } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subMonths } from "date-fns";
import { uniq } from "lodash";

export class EvaluateShortTlc extends UserEvaluatorBase {
    getName () {
        return "Short TLC Bot";
    };

    override preEvaluateComment(event: CommentSubmit): boolean {
        if (!event.comment || !event.author) {
            return false;
        }

        if (isCommentId(event.comment.parentId)) {
            return false;
        }

        if (event.comment.body.includes("\n")) {
            return false;
        }

        if (!usernameMatchesBotPatterns(event.author.name, event.author.karma)) {
            return false;
        }

        return true;
    }

    override preEvaluatePost(post: Post): boolean {
        return false;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (user.commentKarma > 500) {
            return false;
        }

        if (user.createdAt < subMonths(new Date(), 3)) {
            return false;
        }

        if (!usernameMatchesBotPatterns(user.username, user.commentKarma)) {
            return false;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- cannot upload without this.
        const userComments = history.filter(item => item instanceof Comment) as Comment[];

        if (history.some(item => item instanceof Post && (item.subredditName !== "AskReddit" || item.url.includes("i.redd.it")))) {
            return false;
        }

        if (userComments.some(comment => isCommentId(comment.parentId))) {
            return false;
        }

        if (userComments.length > 1 && uniq(userComments.map(comment => comment.subredditName)).length === 1) {
            return false;
        }

        if (userComments.some(comment => comment.body.length > 500)) {
            return false;
        }

        if (userComments.some(comment => comment.body.includes("\n"))) {
            return false;
        }

        if (userComments.some(comment => comment.edited)) {
            return false;
        }

        if (userComments.length < 5) {
            return false;
        }

        return true;
    }
}

const botUsernameRegexes = [
    /^(?:[A-Z][a-z]+[_-]?){2}\d{2,4}$/, // Usernames that resemble "default" WordWordNumber accounts
    /^[A-Z]?[a-z]+[0-9]{1,2}[AEIOU][0-9]{1,2}[A-Z]?[a-z]+\d{0,3}$/, // e.g. Margaret3U88Nelson, Elizabeth5O3Perez20, patricia0E8efimov
    /^[A-Z][a-z]+\d[a-z]\d[A-Z][a-z]+\d{1,3}$/, // e.g. Michelle8o4Mitchell0, Dorothy6s1Martin1
    /^[A-Z][a-z]+\d{2,4}[a-z]+$/, // e.g. Patricia99kozlov, Michelle2012danilov
    /^(?:[A-Z][a-z]+){1,2}\d[a-z](?:[a-z0-9]){2}$/, // e.g. MichelleWilson3g33, RuthGreen1r60, Laura9l7m
    /^(?:[A-Z][a-z]+_){2}[a-z]{2}$/, // e.g. Laura_Parker_ea, Sandra_Jones_jd
];

const autogenRegex = /^((Aardvark|Abalone|Abbreviations|Abies|Ability|Abject|Able|Abroad|Abrocoma|Academic|Acadia|Acanthaceae|Acanthisitta|Acanthocephala|Acanthopterygii|Acceptable|Access|Accident|Accomplished|According|Account|Accountant|Accurate|Acrobatic|Act|Action|Active|Activity|Actual|Actuary|Actuator|Ad|Adagio|Addendum|Addition|Additional|Address|Adept|Adeptness|Adhesiveness|Administration|Administrative|Admirable|Adorable|Advance|Advanced|Advantage|Adventurous|Advertising|Advice|Advisor|Aerie|Affect|Affectionate|Afraid|After|Afternoon|Age|Agency|Agent|Aggravating|Aggressive|Agile|Agitated|Agreeable|Aide|Aioli|Air|Airline|Airport|Alarm|Alarmed|Alarming|Albatross|Alert|Alfalfa|Algae|Alive|Alone|Alps|Alternative|Altruistic|Amazing|Ambassador|Ambition|Ambitious|Amoeba|Amount|Amphibian|Analysis|Analyst|Ancient|Angle|Animal|Animator|Annual|Answer|Ant|Anteater|Antelope|Antique|Anxiety|Anxious|Any|Anybody|Anything|Anywhere|Apart|Apartment|Appeal|Appearance|Apple|Apples|Application|Appointment|Apprehensive|Appropriate|Apricot|Arachnid|Archer|Area|Argument|Arm|Armadillo|Army|Aromatic|Arrival|Art|Artichoke|Article|Artist|Artistic|Arugula|Ashamed|Aside|Ask|Asleep|Asparagus|Aspect|Assignment|Assist|Assistance|Assistant|Associate|Association|Assumption|Astronaut|Astronomer|Athlete|Atmosphere|Attempt|Attention|Attitude|Attorney|Audience|Author|Automatic|Available|Average|Avocado|Avocados|Award|Aware|Awareness|Away|Awkward|Baby|Back|Background|Bad|Badger|Bag|Bake|Baker|Balance|Ball|Banana|Bananas|Band|Bandicoot|Bank|Bar|Barber|Barnacle|Barracuda|Base|Baseball|Basic|Basil|Basis|Basket|Bass|Bat|Bath|Bathroom|Battle|Beach|Beans|Bear|Beat|Beautiful|Bed|Bedroom|Bee|Beginning|Being|Bell|Belt|Bench|Bend|Beneficial|Benefit|Berry|Best|Bet|Better|Beyond|Bicycle|Bid|Big|Bike|Bill|Bird|Birthday|Biscotti|Bison|Bit|Bite|Bitter|Blackberry|Blacksmith|Block|Blood|Blueberry|Bluebird|Bluejay|Board|Boat|Bobcat|Body|Bodybuilder|Bonus|Book|Bookkeeper|Books|Boot|Border|Boring|Born|Boss|Both|Bother|Bottle|Bowl|Bowler|Box|Boysenberry|Brain|Branch|Brave|Bread|Breadfruit|Break|Breakfast|Breath|Brick|Bridge|Brief|Bright|Brilliant|Broad|Broccoli|Brother|Brush|Bubbly|Buddy|Budget|Buffalo|Bug|Builder|Building|Bulky|Bullfrog|Bumblebee|Bunch|Bunnies|Bus|Business|Busy|Butterfly|Butterscotch|Button|Buy|Buyer|Cabinet|Cable|Cake|Cakes|Calendar|Call|Calligrapher|Calm|Camel|Camera|Camp|Campaign|Can|Canary|Cancel|Candid|Candidate|Candle|Candy|Cantaloupe|Cap|Capable|Capers|Capital|Captain|Car|Caramel|Card|Cardiologist|Care|Career|Careful|Caregiver|Careless|Carob|Carpenter|Carpet|Carrot|Carry|Cartographer|Cartoonist|Case|Cash|Cat|Catch|Category|Caterpillar|Cattle|Cauliflower|Cause|Cautious|Celebration|Celery|Cell|Cellist|Certain|Chain|Chair|Challenge|Champion|Championship|Chance|Change|Channel|Chapter|Character|Chard|Charge|Charity|Charming|Chart|Cheap|Check|Cheek|Cheesecake|Cheetah|Chef|Chemical|Chemist|Chemistry|Cherry|Chest|Chicken|Chickens|Childhood|Chip|Chipmunk|Chocolate|Choice|Cicada|Citron|City|Civil|Claim|Class|Classic|Classroom|Clean|Clear|Clerk|Click|Client|Climate|Clock|Clothes|Cloud|Club|Clue|Coach|Coast|Coat|Cobbler|Cockroach|Coconut|Cod|Code|Coffee|Cold|Collar|Collection|College|Comb|Combination|Comedian|Comfort|Comfortable|Comics|Command|Comment|Commercial|Commission|Committee|Common|Communication|Community|Company|Comparison|Competition|Competitive|Complaint|Complete|Complex|Compliments|Composer|Compote|Comprehensive|Computer|Concentrate|Concept|Concern|Concert|Conclusion|Condition|Confection|Confections|Conference|Confidence|Confident|Conflict|Confusion|Connect|Connection|Conscious|Consequence|Consideration|Consistent|Constant|Construction|Contact|Content|Contest|Context|Contract|Contribution|Control|Conversation|Cook|Cookie|Cookies|Cool|Copy|Corgi|Corner|Correct|Cost|Count|Counter|Country|County|Couple|Courage|Course|Court|Cover|Cow|Coyote|Crab|Craft|Crafty|Cranberry|Crazy|Cream|Creative|Credit|Creepy|Creme|Cress|Crew|Cricket|Crickets|Critical|Criticism|Crow|Cry|Cryptographer|Cucumber|Cultural|Culture|Cup|Cupcake|Cupcakes|Curious|Currency|Current|Curve|Custard|Customer|Cut|Cute|Cycle|Daikon|Damage|Dance|Dangerous|Dapper|Dare|Dark|Data|Database|Date|Day|Dazzling|Deal|Dealer|Dear|Debate|Debt|Decent|Decision|Deep|Deer|Defiant|Definition|Degree|Delay|Delicious|Delivery|Demand|Dense|Dentist|Department|Departure|Dependent|Depth|Description|Design|Designer|Desk|Desperate|Detail|Detective|Development|Device|Diamond|Diet|Difference|Different|Difficult|Difficulty|Dig|Diligent|Dimension|Dingo|Dingos|Dinner|Direct|Direction|Director|Dirt|Disaster|Disastrous|Discipline|Discombobulated|Discount|Discussion|Dish|Disk|Dismal|Display|Distance|Distinct|Distribution|District|Diver|Divide|Dizzy|Doctor|Document|Dog|Doggos|Donkey|Donkeys|Donut|Donuts|Doodles|Door|Dot|Double|Doubt|Doubts|Doughnut|Doughnuts|Downtown|Draft|Drag|Dragonfly|Dragonfruit|Drama|Dramatic|Draw|Drawer|Drawing|Drawings|Dream|Dress|Drink|Drive|Driver|Drop|Drummer|Dry|Duck|Ducks|Due|Dull|Durian|Dust|Duty|Eagle|Eagles|Ear|Early|Earth|Ease|East|Eastern|Easy|Ebb|Echidna|Echo|Economics|Economist|Economy|Ecstatic|Edge|Editor|Education|Educational|Educator|Effect|Effective|Efficiency|Efficient|Effort|Egg|Eggplant|Either|Elderberry|Election|Electrical|Electronic|Elegant|Elephant|Elevator|Elk|Embarrassed|Emergency|Emotion|Emotional|Emphasis|Employ|Employee|Employer|Employment|Empty|Emu|End|Energy|Engine|Engineer|Engineering|Enough|Entertainer|Entertainment|Enthusiasm|Entire|Entrance|Entrepreneur|Entry|Environment|Environmental|Equal|Equipment|Equivalent|Error|Escape|Essay|Establishment|Estate|Estimate|Euphoric|Even|Evening|Event|Every|Evidence|Exact|Exam|Examination|Example|Excellent|Exchange|Excitement|Exciting|Excuse|Exercise|Existing|Exit|Exotic|Expensive|Experience|Expert|Explanation|Explorer|Express|Expression|Extension|Extent|External|Extra|Extreme|Eye|Fabulous|Face|Fact|Factor|Fail|Fair|Faithlessness|Falcon|Fall|False|Familiar|Famous|Fan|Fancy|Fantastic|Far|Farm|Farmer|Fast|Fault|Fearless|Feature|Federal|Fee|Feed|Feedback|Feeling|Feisty|Fennel|Ferret|Few|Fickle|Field|Fig|Figure|File|Fill|Film|Final|Finance|Financial|Finding|Fine|Finger|Finish|Firefighter|Firm|First|Fish|Fisherman|Fishing|Fit|Fix|Flaky|Flamingo|Flan|Flashy|Flat|Flatworm|Flight|Flimsy|Floofs|Floor|Flounder|Flow|Flower|Fluffy|Fluid|Fly|Focus|Fold|Following|Fondant|Food|Foot|Football|Force|Foreign|Forever|Form|Formal|Former|Forsaken|Fortune|Forward|Foundation|Fox|Foxes|Fragrant|Frame|Free|Freedom|Frequent|Fresh|Friend|Friendly|Friendship|Front|Frosting|Frosty|Froyo|Fruit|Fudge|Fuel|Full|Fun|Function|Funny|Future|Fuzzy|Gadgets|Gain|Ganache|Gap|Garage|Garbage|Garden|Garlic|Gas|Gate|Gazelle|Gear|Gene|General|Geologist|Gift|Giraffe|Giraffes|Glad|Glass|Glittering|Global|Gloomy|Glove|Glum|Goal|Goat|Goats|Gold|Golf|Good|Goose|Government|Grab|Grade|Grand|Grape|Grapefruit|Grapes|Grass|Great|Greedy|Green|Grocery|Grouchy|Ground|Groundbreaking|Group|Growth|Guarantee|Guard|Guava|Guavas|Guess|Guest|Guidance|Guide|Guilty|Guitar|Gullible|Gur|Habit|Habits|Hair|Hairy|Half|Hall|Hamster|Hamsters|Hand|Handle|Happy|Hat|Haunting|Hawk|Head|Health|Healthy|Hearing|Heart|Heat|Heavy|Hedgehog|Hefty|Height|Helicopter|Help|Helpful|Heron|Hesitations|Highlight|Highway|Hippo|Historian|Historical|History|Hobbies|Hold|Holiday|Home|Homework|Honest|Honey|Honeydew|Hope|Hopeful|Hornet|Horror|Horse|Hospital|Host|Hot|Hotel|Hour|House|Housing|Hovercraft|Huckleberry|Huge|Human|Humble|Humor|Hungry|Hunt|Hunter|Hurry|Hyena|Ice|Icy|Idea|Ideal|Ill|Illustrator|Illustrious|Image|Imaginary|Imagination|Immediate|Impact|Implement|Importance|Important|Impossible|Impress|Impression|Impressive|Improvement|Incident|Income|Increase|Independence|Independent|Indication|Individual|Industry|Inevitable|Infamous|Infinite|Inflation|Influence|Informal|Information|Ingenuity|Initial|Initiative|Injury|Inner|Insect|Inside|Inspection|Inspector|Instance|Instruction|Insurance|Intelligent|Intention|Interaction|Interest|Interesting|Intern|Internal|International|Internet|Interview|Intrepid|Introduction|Investigator|Investment|Invite|Iron|Island|Isopod|Issue|Itchy|Item|Jacket|Jackfruit|Jaded|Jaguar|Jazzlike|Jealous|Jello|Jelly|Jellyfish|Jeweler|Jicama|Job|Joke|Jokes|Jolly|Journalist|Judge|Judgment|Juggernaut|Juice|Jump|Jumpy|Junior|Junket|Jury|Just|Kale|Kaleidoscope|Kangaroo|Key|Kick|Kind|Kindheartedness|Kindly|King|Kitchen|Kiwi|Kiwis|Klutzy|Knee|Knowledge|Known|Koala|Kooky|Lab|Lack|Ladder|Lake|Land|Landscape|Language|Lanky|Large|Last|Late|Latter|Laugh|Lavishness|Law|Lawfulness|Lawyer|Layer|Lazy|Lead|Leader|Leadership|Leading|League|Least|Leather|Leave|Lecture|Leek|Left|Leg|Legal|Legitimate|Lemon|Lemons|Length|Lengthiness|Lentils|Leopard|Less|Let|Letter|Letterhead|Lettuce|Level|Librarian|Library|Lie|Life|Lifeguard|Light|Lime|Limit|Limp|Line|Lingonberry|Link|Lion|List|Listen|Literature|Little|Live|Livid|Living|Load|Loan|Lobster|Lobsters|Local|Location|Lock|Locksmith|Log|Logical|Lonely|Long|Longjumping|Look|Loose|Lopsided|Loquat|Loss|Lost|Loud|Love|Low|Lower|Luck|Lucky|Lumpy|Lunch|Lychee|Lynx|Macaron|Macarons|Macaroon|Machine|Machines|Magazine|Magician|Mail|Main|Maintenance|Maize|Majestic|Major|Maleficent|Mall|Mammoth|Management|Manager|Mango|Manner|Manufacturer|Many|Map|Maps|March|Marionberry|Mark|Market|Marketing|Marsupial|Marzipan|Massive|Master|Masterpiece|Mastodon|Match|Material|Math|Mathematician|Matter|Maximum|Maybe|Meal|Mean|Meaning|Measurement|Meat|Mechanic|Media|Medical|Medicine|Mediocre|Medium|Meet|Meeting|Melodic|Membership|Memory|Mental|Mention|Menu|Meringue|Mess|Message|Metal|Method|Middle|Midnight|Might|Milk|Mind|Mindless|Mine|Minimum|Minute|Mirror|Miserable|Mission|Mistake|Mix|Mixture|Mobile|Mode|Moist|Molasses|Moment|Money|Mongoose|Monitor|Monk|Month|Mood|Moose|More|Morning|Mortgage|Most|Mother|Motor|Mountain|Mouse|Mousse|Move|Movie|Much|Mud|Muffin|Muffins|Mulberry|Mundane|Murky|Muscle|Mushroom|Music|Musician|Muted|Mycologist|Mysterious|Nail|Naive|Name|Narrow|Narwhal|National|Natural|Nature|Nearby|Neat|Nebula|Necessary|Neck|Nectarine|Needleworker|Nefariousness|Negative|Negotiation|Neighborhood|Neither|Nerve|Nervous|Net|Network|New|News|Newspaper|Newt|Next|Nice|Night|Ninja|No|Nobody|Noise|Normal|North|Nose|Note|Nothing|Notice|Novel|Number|Numerous|Object|Objective|Obligation|Obvious|Occasion|Ocelot|Odd|Offer|Office|Oil|Ok|Okra|Old|Olive|One|Onion|Onions|Only|Open|Opening|Operation|Opinion|Opinions|Opportunity|Opposite|Optimal|Option|Orange|Oranges|Orchid|Order|Ordinary|Organic|Organization|Original|Ornery|Ostrich|Other|Otherwise|Outcome|Outlandishness|Outrageous|Outside|Oven|Over|Overall|Owl|Own|Pace|Pack|Package|Page|Pain|Paint|Painter|Painting|Pair|Pale|Paleontologist|Palpitation|Panda|Pandas|Pangolin|Panic|Papaya|Paper|Paramedic|Parfait|Park|Parking|Parsley|Parsnip|Part|Particular|Party|Pass|Passage|Passenger|Passion|Past|Path|Patience|Patient|Pattern|Pause|Pay|Payment|Pea|Peace|Peach|Peak|Peanut|Peanuts|Pear|Pears|Pen|Penalty|Pension|Pepper|Peppers|Percentage|Perception|Perfect|Performance|Performer|Permission|Permit|Persimmon|Personal|Personality|Perspective|Phase|Philosopher|Philosophy|Phone|Photo|Photograph|Phrase|Physical|Physics|Pianist|Piano|Piccolo|Pick|Pickle|Pickles|Picture|Pie|Piece|Piglet|Pilot|Pin|Pineapple|Pipe|Pirate|Pitch|Pitiful|Pizza|Place|Plan|Plane|Plankton|Plant|Plantain|Plastic|Plate|Platform|Platypus|Play|Playful|Pleasant|Plenty|Plum|Plus|Poem|Poems|Poet|Poetry|Point|Policy|Pollution|Pomegranate|Pomelo|Pool|Pop|Popular|Position|Positive|Possession|Possibility|Possible|Post|Potato|Potential|Pound|Power|Powerful|Practical|Practice|Praline|Predictions|Preference|Preparation|Presence|Present|Presentation|Pressure|Prestigious|Pretend|Pretty|Previous|Price|Pride|Primary|Principle|Print|Prior|Priority|Pristine|Prize|Problem|Procedure|Process|Produce|Product|Profession|Professional|Professor|Profile|Profit|Program|Programmer|Progress|Project|Promise|Promotion|Prompt|Proof|Proper|Property|Proposal|Protection|Proud|Prudent|Prune|Psychological|Psychology|Public|Pudding|Pumpkin|Puppers|Purchase|Pure|Purple|Purpose|Push|Put|Putrid|Puzzled|Puzzleheaded|Quail|Quality|Quantity|Quarter|Queasy|Question|Quick|Quiet|Quirky|Quit|Quote|Rabbit|Rabbits|Raccoon|Race|Radiant|Radio|Radish|Radishes|Rain|Raise|Raisin|Range|Ranger|Rare|Raspberry|Rate|Ratio|Razzmatazz|Reach|Reaction|Read|Reading|Ready|Real|Realistic|Reality|Reason|Reasonable|Recent|Reception|Recipe|Recipes|Recognition|Recommendation|Record|Recording|Recover|Reference|Reflection|Refrigerator|Refuse|Region|Register|Regret|Regrets|Regular|Reindeer|Relation|Relationship|Relative|Release|Relevant|Relief|Remarkable|Remote|Remove|Rent|Repair|Repeat|Replacement|Reply|Report|Reporter|Representative|Republic|Repulsive|Reputation|Requirement|Research|Researcher|Reserve|Resident|Resist|Resolution|Resolve|Resort|Resource|Respect|Respond|Response|Responsibility|Responsible|Rest|Restaurant|Result|Return|Reveal|Revelations|Revenue|Review|Revolution|Revolutionary|Reward|Rhubarb|Rice|Rich|Ride|Right|Ring|Rip|Rise|Risk|River|Road|Robots|Rock|Role|Roll|Roof|Room|Rooster|Rope|Rough|Round|Routine|Row|Royal|Rub|Rude|Ruin|Rule|Run|Rush|Rutabaga|Sad|Safe|Safety|Sail|Salad|Salamander|Salary|Sale|Salt|Salty|Same|Sample|Sand|Sandwich|Satisfaction|Savings|Scale|Scallion|Scar|Scarcity|Scared|Scary|Scene|Schedule|Scheme|Scholar|School|Science|Scientist|Score|Scratch|Screen|Sea|Seagulls|Search|Season|Seat|Seaweed|Seaworthiness|Second|Secret|Secretary|Section|Sector|Secure|Security|Seesaw|Select|Selection|Self|Sell|Senior|Sense|Sensitive|Sentence|Separate|Series|Serious|Serve|Service|Session|Set|Setting|Several|Severe|Shake|Shallot|Shame|Shape|Share|Sharp|Sheepherder|Shelter|Sherbert|Sherbet|Shift|Shine|Ship|Shirt|Shock|Shoddy|Shoe|Shop|Shopping|Short|Shot|Shoulder|Show|Shower|Side|Sign|Signal|Signature|Significance|Significant|Silent|Silly|Silver|Similar|Simple|Singer|Single|Sink|Sir|Site|Situation|Size|Sketches|Skill|Skin|Skirt|Sky|Sleep|Slice|Slide|Slight|Slip|Slow|Small|Smart|Smell|Smile|Smoke|Smooth|Snoo|Snow|Society|Sock|Soft|Software|Soggy|Soil|Solid|Solution|Some|Somewhere|Song|Songs|Sorbet|Sorry|Sort|Sound|Soup|Source|South|Southern|Space|Spare|Speaker|Special|Specialist|Specific|Speech|Speed|Spell|Spend|Spinach|Spirit|Spirited|Spiritual|Spite|Split|Sport|Spot|Spray|Spread|Spring|Sprinkles|Sprouts|Square|Squash|Squirrel|Squirrels|Stable|Staff|Stage|Stand|Standard|Star|Start|State|Statement|Station|Statistician|Status|Stay|Steak|Step|Stick|Still|Stock|Stomach|Stop|Storage|Store|Stories|Storm|Story|Straight|Strain|Strange|Stranger|Strategy|Strawberry|Street|Strength|Stress|Stretch|Strict|Strike|Striking|String|Strong|Structure|Struggle|Student|Studio|Study|Stuff|Stunning|Style|Subject|Substance|Substantial|Success|Successful|Succotash|Such|Sudden|Sufficient|Sugar|Suggestion|Suggestions|Suit|Suitable|Summer|Sun|Sundae|Super|Superb|Supermarket|Support|Sure|Surprise|Surround|Survey|Suspect|Suspicious|Swan|Sweaty|Sweet|Swim|Swimmer|Swimming|Swing|Switch|Swordfish|Syllabub|Sympathy|Syrup|System|Table|Tackle|Tadpole|Tailor|Tale|Talk|Tall|Tangelo|Tangerine|Tank|Tap|Target|Taro|Tart|Task|Taste|Tasty|Tax|Tea|Teach|Teacher|Teaching|Team|Tear|Technical|Technician|Technology|Telephone|Television|Tell|Temperature|Temporary|Tennis|Tension|Term|Terrible|Test|Text|Thanks|That|Theme|Then|Theory|These|Thick|Thin|Thing|Think|This|Thought|Throat|Ticket|Tie|Tiger|Tigers|Tight|Till|Time|Timely|Tiny|Tip|Title|Today|Toe|Tomatillo|Tomato|Tomatoes|Tomorrow|Tone|Tonight|Tooth|Top|Topic|Total|Touch|Tough|Tour|Tourist|Towel|Tower|Town|Track|Trade|Tradition|Traditional|Traffic|Train|Trainer|Training|Transition|Translator|Transportation|Trash|Travel|Treacle|Treat|Tree|Trick|Tricky|Trifle|Trip|Trouble|Truck|True|Trust|Truth|Try|Tumbleweed|Tune|Turbulent|Turn|Turnip|Turnover|Tutor|Twist|Two|Type|Typical|Umpire|Unable|Understanding|Unfair|Unhappy|Union|Unique|Unit|United|University|Unlikely|Unlucky|Unusual|Upbeat|Upper|Upset|Upstairs|Use|Used|Useful|Usual|Vacation|Valuable|Value|Vanilla|Variation|Variety|Various|Vast|Vegetable|Vehicle|Vermicelli|Version|Veterinarian|Victory|Video|View|Village|Violinist|Virtual|Virus|Visible|Visit|Visual|Vivid|Voice|Volume|Wafer|Wait|Walk|Wall|Wallaby|Walrus|Walruses|Waltz|War|Warm|Warning|Warthog|Wasabi|Wash|Waste|Watch|Water|Watercress|Watermelonlesson|Wave|Way|Weak|Weakness|Wealth|Wear|Weary|Weather|Web|Wedding|Week|Weekend|Weekly|Weight|Weird|Welcome|Welder|Werewolf|West|Western|Wheel|Whereas|Which|While|Whole|Wide|Wild|Will|Willing|Willingness|Willow|Win|Wind|Window|Wing|Winner|Winter|Wise|Wish|Wishbone|Witness|Witty|Wolf|Wolverine|Wonder|Wonderful|Wooden|Woodpecker|Woofers|Word|Words|Work|Worker|Working|World|Worldliness|Worldly|Worried|Worry|Worth|Wrangler|Wrap|Writer|Writing|Wrong|Wrongdoer|Yak|Yam|Yard|Year|Yellow|Yesterday|Yoghurt|Yogurt|Yogurtcloset|You|Young|Youth|Zealousideal|Zebra|Zestyclose|Zombie|Zone|Zookeepergame|Zucchini)[-_]?){1,2}\d{0,4}$/;

function usernameMatchesBotPatterns (username: string, karma?: number): boolean {
    // Check against known bot username patterns.
    if (!botUsernameRegexes.some(regex => regex.test(username))) {
        return false;
    }

    if (!karma || karma > 3) {
        // LLM bots sometimes use the same keywords as Reddit's autogen algorithm, but too prone to false positives
        // for established accounts.
        return !autogenRegex.test(username);
    }

    return true;
}

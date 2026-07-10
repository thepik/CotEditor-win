export namespace main {
	
	export class FileContent {
	    path?: string;
	    content: string;
	    encoding: string;
	    line_ending: string;
	
	    static createFrom(source: any = {}) {
	        return new FileContent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.encoding = source["encoding"];
	        this.line_ending = source["line_ending"];
	    }
	}

}


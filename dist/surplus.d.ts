interface S {
	// Computation root
	root<T>(fn : (dispose? : () => void) => T) : T;

	// Computation constructors
	<T>(fn : () => T) : () => T;
	<T>(fn : (v : T) => T, seed : T) : () => T;
	on<T>(ev : () => any, fn : () => T) : () => T;
	on<T>(ev : () => any, fn : (v : T) => T, seed : T, onchanges?: boolean) : () => T;

	// Data signal constructors
	data<T>(value : T) : S.DataSignal<T>;
	value<T>(value : T, eq? : (a : T, b : T) => boolean) : S.DataSignal<T>;

	// Batching changes
	freeze<T>(fn : () => T) : T;

	// Sampling a signal
	sample<T>(fn : () => T) : T;
	
	// Freeing external resources
	cleanup(fn : (final : boolean) => any) : void;

	// subclocks
	subclock() : <T>(fn : () => T) => T;
	subclock<T>(fn : () => T) : T;
}

declare namespace S { 
	interface DataSignal<T> {
		() : T;
		(val : T) : T;
	}

	interface SumSignal<T> {
		() : T;
		(update? : (value: T) => T) : T;
	}
}

declare var S : S;

//export = S;

interface Html {
	(id : number, html : string) : HTMLElement;
	insert(node : HTMLElement, value : any, state : HTMLElement) : HTMLElement;
	data(data : (v? : any) => any, event? : string) : HtmlMixin;
	focus(flag : Boolean, start? : number, end? : number) : HtmlMixin;
	onkey : {
		(key : string, callback : (key : KeyboardEvent) => void) : HtmlMixin;
		(key : string, event : string, callback : (key : KeyboardEvent) => void) : HtmlMixin;
	};
	class : {
		(name : string, flag : Boolean) : void;
		(name : string, alternate : string, flag : Boolean) : HtmlMixin;
	};
	exec(fn : (state? : any) => any) : any;
}

interface HtmlMixin {
	(node : HTMLElement, state : any) : any;
}

declare var Html : Html;

export = Html;
In Ruby, several common design patterns are used to solve recurring design problems and improve code readability, maintainability, and scalability. Here are a few:

1. **Singleton Pattern**: This pattern restricts the instantiation of a class to a single instance. It is used where only a single instance of a class is required to control actions.

2. **Factory Pattern**: This pattern provides a way to delegate the instantiation logic to child classes. It is used when a class cannot anticipate the type of objects it needs to create.

3. **Decorator Pattern**: This pattern allows behavior to be added to an individual object, either statically or dynamically, without affecting the behavior of other objects from the same class.

4. **Observer Pattern**: This pattern is a software design pattern in which an object, named the subject, maintains a list of its dependents, called observers, and notifies them automatically of any state changes, usually by calling one of their methods.

5. **Strategy Pattern**: This pattern enables an algorithm's behavior to be selected at runtime. It defines a family of algorithms, encapsulates each one, and makes them interchangeable.

6. **Template Method Pattern**: This pattern defines the skeleton of an algorithm in a method, deferring some steps to subclasses. It lets subclasses redefine certain steps of an algorithm without changing the algorithm's structure.

7. **Command Pattern**: This pattern encapsulates a request as an object, thereby letting users parameterize clients with queues, requests, and operations.

8. **Adapter Pattern**: This pattern allows the interface of an existing class to be used as another interface. It is often used to make existing classes work with others without modifying their source code.

9. **Prototype Pattern**: This pattern is used when the type of objects to create is determined by a prototypical instance, which is cloned to produce new objects.

10. **Composite Pattern**: This pattern composes objects into tree structures to represent part-whole hierarchies. It allows clients to treat individual objects and compositions of objects uniformly.

These patterns are not exclusive to Ruby and can be found in many other object-oriented programming languages. They are part of the broader set of design patterns known as the Gang of Four (GoF) design patterns.